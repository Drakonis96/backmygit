import path from 'node:path';

function list(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('PUBLIC_URL must be an absolute HTTP(S) URL without credentials');
  if (parsed.pathname !== '/' && parsed.pathname !== '')
    throw new Error('PUBLIC_URL path prefixes are not supported');
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

const publicUrl = optionalUrl(process.env.PUBLIC_URL);
const allowedHosts = new Set(list(process.env.ALLOWED_HOSTS).map((host) => host.toLowerCase()));
if (publicUrl) allowedHosts.add(publicUrl.host.toLowerCase());

export const config = {
  port: Number(process.env.PORT || 8787),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  backupRoot: path.resolve(process.env.BACKUP_ROOT || './backups'),
  backupHostPath: process.env.BACKUP_HOST_PATH || process.env.BACKUP_ROOT || './backups',
  appVersion: process.env.APP_VERSION || '0.1.0',
  workerConcurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2)),
  minFreeBytes: Math.max(0, Number(process.env.MIN_FREE_BYTES || 536870912)),
  gitTimeoutMs: Math.max(60_000, Number(process.env.GIT_TIMEOUT_MS || 1800000)),
  publicUrl,
  allowedHosts,
  trustedProxies: list(process.env.TRUSTED_PROXIES),
  forceHttps: process.env.FORCE_HTTPS === 'true' || publicUrl?.protocol === 'https:',
  bootstrapTokenPath: path.resolve(process.env.BOOTSTRAP_TOKEN_PATH || path.join(process.env.DATA_DIR || './data', 'bootstrap-token')),
  sessionIdleMs: Math.max(5 * 60_000, Number(process.env.SESSION_IDLE_MS || 30 * 60_000)),
  sessionAbsoluteMs: Math.max(30 * 60_000, Number(process.env.SESSION_ABSOLUTE_MS || 12 * 60 * 60_000)),
  isProduction: process.env.NODE_ENV === 'production'
};
