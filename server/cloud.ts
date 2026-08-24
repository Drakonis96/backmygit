import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { db } from './db.js';
import { normalizeRemoteSubpath, remotePath, runRclone, withRcloneConfig } from './rclone.js';

export const cloudProviders = [
  { id: 'drive', name: 'Google Drive', authModes: ['managed_oauth'] },
  { id: 'dropbox', name: 'Dropbox', authModes: ['managed_oauth'] },
  { id: 'onedrive', name: 'Microsoft OneDrive', authModes: ['managed_oauth'] },
  { id: 'mega', name: 'MEGA', authModes: ['managed_credentials'] },
  { id: 's3', name: 'S3 compatible', authModes: ['managed_credentials'] },
  { id: 'external', name: 'Existing rclone remote', authModes: ['external'] },
] as const;

function privateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
    normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:169.254.');
}

export async function validateCloudEndpoint(value: string): Promise<string> {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
    throw new Error('Cloud endpoints must be origins without credentials, paths, query strings, or fragments');
  if (!config.allowPrivateCloudEndpoints && endpoint.protocol !== 'https:')
    throw new Error('Cloud endpoints must use HTTPS');
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Cloud endpoint protocol is not supported');
  if (!config.allowPrivateCloudEndpoints) {
    if (endpoint.hostname === 'localhost' || endpoint.hostname.endsWith('.localhost') || endpoint.hostname.endsWith('.local'))
      throw new Error('Private cloud endpoints are disabled');
    const addresses = await dns.lookup(endpoint.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => privateIp(item.address)))
      throw new Error('Private cloud endpoints are disabled');
  }
  return endpoint.origin;
}

export function getConnection(id: string): any {
  const connection = db.prepare('SELECT * FROM cloud_connections WHERE id=?').get(id);
  if (!connection) throw Object.assign(new Error('Cloud connection not found'), { status: 404 });
  return connection;
}

export async function browseRemote(connection: any, folder: string): Promise<Array<{ name: string; path: string; id?: string }>> {
  const normalized = normalizeRemoteSubpath(folder);
  return withRcloneConfig(connection, async configPath => {
    const { stdout } = await runRclone([
      'lsjson', '--dirs-only', '--max-depth', '1', '--no-mimetype',
      remotePath(connection.remote_name, normalized),
    ], { configPath, timeoutMs: 45_000, maxBuffer: 4 * 1024 * 1024 });
    const rows = JSON.parse(stdout) as Array<{ Name?: unknown; Path?: unknown; ID?: unknown; IsDir?: unknown }>;
    if (!Array.isArray(rows)) throw new Error('Unexpected response from rclone');
    return rows.filter(row => row.IsDir === true && typeof row.Name === 'string' && typeof row.Path === 'string')
      .slice(0, 2000)
      .map(row => ({ name: String(row.Name), path: normalizeRemoteSubpath([normalized, String(row.Path)].filter(Boolean).join('/')), id: typeof row.ID === 'string' ? row.ID : undefined }));
  });
}

export async function testCloudConnection(connection: any): Promise<void> {
  await browseRemote(connection, '');
}
