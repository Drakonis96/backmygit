import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

export function privateOrReservedIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(normalized)) {
    const [a, b, c] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (!net.isIPv6(normalized)) return true;
  // Reject every IPv4-mapped form, including hexadecimal forms such as
  // ::ffff:a00:1, so private IPv4 ranges cannot bypass validation.
  if (normalized.startsWith('::ffff:')) return true;
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') || normalized.startsWith('2001:2:') ||
    normalized.startsWith('2001:10:') || normalized.startsWith('2001:20:');
}

export async function validateCloudEndpoint(value: string): Promise<string> {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
    throw new Error('Cloud endpoints must be origins without credentials, paths, query strings, or fragments');
  if (!config.allowPrivateCloudEndpoints && endpoint.protocol !== 'https:')
    throw new Error('Cloud endpoints must use HTTPS');
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Cloud endpoint protocol is not supported');
  if (!config.allowPrivateCloudEndpoints) {
    const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
      throw new Error('Private cloud endpoints are disabled');
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => privateOrReservedIp(item.address)))
      throw new Error('Private cloud endpoints are disabled');
  }
  return endpoint.origin;
}
