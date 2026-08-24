import { db } from './db.js';
import { normalizeRemoteSubpath, remotePath, runRclone, withRcloneConfig } from './rclone.js';
export { validateCloudEndpoint } from './cloud-endpoint.js';

export const cloudProviders = [
  { id: 'drive', name: 'Google Drive', authModes: ['managed_oauth'] },
  { id: 'dropbox', name: 'Dropbox', authModes: ['managed_oauth'] },
  { id: 'onedrive', name: 'Microsoft OneDrive', authModes: ['managed_oauth'] },
  { id: 'mega', name: 'MEGA', authModes: ['managed_credentials'] },
  { id: 's3', name: 'S3 compatible', authModes: ['managed_credentials'] },
  { id: 'external', name: 'Existing rclone remote', authModes: ['external'] },
] as const;

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
