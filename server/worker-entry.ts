import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import './db.js';
import { rcloneVersion } from './rclone.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { ensureMasterKey } from './secrets.js';
import { reconcileFilesystem } from './storage.js';
import { startWorker, stopWorker } from './worker.js';

if (config.processRole !== 'worker')
  throw new Error('The worker entrypoint requires PROCESS_ROLE=worker');

await fs.mkdir(config.dataDir, { recursive: true });
await fs.mkdir(config.backupRoot, { recursive: true });
await ensureMasterKey();
const temporaryRoot = path.join(config.backupRoot, '.tmp');
await fs.mkdir(temporaryRoot, { recursive: true });
for (const stale of await fs.readdir(temporaryRoot))
  await fs.rm(path.join(temporaryRoot, stale), { recursive: true, force: true });
await reconcileFilesystem();

try {
  console.log(`Transfer engine ready: ${await rcloneVersion()}`);
} catch (error) {
  console.error('rclone validation failed; local backups remain available', error);
}

startWorker();
startScheduler();
console.log(`BackMyGit ${config.appVersion} worker started`);
const keepAlive = setInterval(() => undefined, 60 * 60_000);

async function shutdown(signal: string) {
  console.log(`${signal} received; stopping worker`);
  clearInterval(keepAlive);
  stopScheduler();
  await stopWorker();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
