import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backmygit-integration-'));
const dataDir = path.join(root, 'data');
const backupRoot = path.join(root, 'backups');
await fs.mkdir(dataDir); await fs.mkdir(backupRoot);
const fakeRclone = path.join(root, 'rclone');
const externalRcloneConfig = path.join(root, 'rclone.conf');
const fakeRemoteRoot = path.join(root, 'remote');
await fs.mkdir(fakeRemoteRoot);
await fs.writeFile(fakeRclone, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const commands = ['version','lsjson','obscure','copyto','hashsum','moveto','deletefile'];
const commandIndex = args.findIndex(arg => commands.includes(arg));
const command = args[commandIndex];
const rest = args.slice(commandIndex + 1);
const remoteRoot = ${JSON.stringify(fakeRemoteRoot)};
function remoteFile(spec) {
  const separator = spec.indexOf(':');
  const relative = spec.slice(separator + 1).split('/').filter(Boolean);
  if (separator < 1 || relative.some(part => part === '..')) throw new Error('invalid remote path');
  return path.join(remoteRoot, ...relative);
}
if (command === 'version') process.stdout.write('rclone v1.75.0\\n');
else if (command === 'lsjson') process.stdout.write('[{"Name":"Projects","Path":"Projects","IsDir":true,"ID":"folder-1"},{"Name":"file.txt","Path":"file.txt","IsDir":false}]\\n');
else if (command === 'obscure') {
  let value = '';
  process.stdin.on('data', chunk => { value += chunk; });
  process.stdin.on('end', () => process.stdout.write('obscured-' + value.trim() + '\\n'));
} else if (command === 'copyto') {
  const source = rest[0].includes(':') ? remoteFile(rest[0]) : rest[0];
  const destination = rest[1].includes(':') ? remoteFile(rest[1]) : rest[1];
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const size = fs.statSync(source).size;
  process.stderr.write(JSON.stringify({ bytes: size, totalBytes: size, speed: size }) + '\\n');
} else if (command === 'hashsum') {
  const source = remoteFile(rest[rest.length - 1]);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  process.stdout.write(hash + '  ' + path.basename(source) + '\\n');
} else if (command === 'moveto') {
  const source = remoteFile(rest[0]); const destination = remoteFile(rest[1]);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
} else if (command === 'deletefile') fs.rmSync(remoteFile(rest[0]), { force: true });
else { process.stderr.write('unsupported fake rclone command\\n'); process.exitCode = 2; }
`);
await fs.chmod(fakeRclone, 0o700);
await fs.writeFile(externalRcloneConfig, '[integration_local]\ntype = local\n');
const port = 28_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: 'production', PROCESS_ROLE: 'web', PORT: String(port), PUBLIC_URL: base, DATA_DIR: dataDir, BACKUP_ROOT: backupRoot, BACKUP_HOST_PATH: backupRoot, RCLONE_BINARY: fakeRclone, RCLONE_CONFIG_FILE: externalRcloneConfig },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
let worker;
let workerLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
const stop = async () => {
  worker?.kill('SIGTERM');
  server.kill('SIGTERM');
  await Promise.race([
    Promise.all([
      new Promise(resolve => server.once('exit', resolve)),
      worker ? new Promise(resolve => worker.once('exit', resolve)) : Promise.resolve(),
    ]),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  await fs.rm(root, { recursive: true, force: true });
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Integration server did not start:\n${serverLog}`);
  worker = spawn(process.execPath, ['dist-server/worker-entry.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', PROCESS_ROLE: 'worker', PUBLIC_URL: base, DATA_DIR: dataDir, BACKUP_ROOT: backupRoot, BACKUP_HOST_PATH: backupRoot, RCLONE_BINARY: fakeRclone, RCLONE_CONFIG_FILE: externalRcloneConfig },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', chunk => { workerLog += chunk; });
  worker.stderr.on('data', chunk => { workerLog += chunk; });
  for (let attempt = 0; attempt < 100 && !workerLog.includes('worker started'); attempt++) {
    if (worker.exitCode !== null) throw new Error(`Integration worker exited early:\n${workerLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!workerLog.includes('worker started')) throw new Error(`Integration worker did not start:\n${workerLog}`);
  const test = spawn(process.execPath, ['scripts/integration-test.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_BASE_URL: base, TEST_BACKUP_ROOT: backupRoot, TEST_DATABASE_PATH: path.join(dataDir, 'backmygit.sqlite'), TEST_REMOTE_ROOT: fakeRemoteRoot },
    stdio: 'inherit',
  });
  const exitCode = await new Promise(resolve => test.once('exit', resolve));
  if (exitCode !== 0) throw new Error(`Integration test exited with code ${exitCode}`);
} finally {
  await stop();
}
