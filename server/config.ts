import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 8787),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  backupRoot: path.resolve(process.env.BACKUP_ROOT || './backups'),
  backupHostPath: process.env.BACKUP_HOST_PATH || process.env.BACKUP_ROOT || './backups',
  appVersion: process.env.APP_VERSION || '0.1.0',
  workerConcurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2)),
  minFreeBytes: Math.max(0, Number(process.env.MIN_FREE_BYTES || 536870912)),
  gitTimeoutMs: Math.max(60_000, Number(process.env.GIT_TIMEOUT_MS || 1800000)),
  isProduction: process.env.NODE_ENV === 'production'
};
