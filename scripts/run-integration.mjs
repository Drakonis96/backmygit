import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backmygit-integration-'));
const dataDir = path.join(root, 'data');
const backupRoot = path.join(root, 'backups');
await fs.mkdir(dataDir); await fs.mkdir(backupRoot);
const port = 28_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATA_DIR: dataDir, BACKUP_ROOT: backupRoot, BACKUP_HOST_PATH: backupRoot },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
const stop = async () => {
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  await fs.rm(root, { recursive: true, force: true });
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Integration server did not start:\n${serverLog}`);
  const test = spawn(process.execPath, ['scripts/integration-test.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_BASE_URL: base, TEST_BACKUP_ROOT: backupRoot, TEST_DATABASE_PATH: path.join(dataDir, 'backmygit.sqlite') },
    stdio: 'inherit',
  });
  const exitCode = await new Promise(resolve => test.once('exit', resolve));
  if (exitCode !== 0) throw new Error(`Integration test exited with code ${exitCode}`);
} finally {
  await stop();
}
