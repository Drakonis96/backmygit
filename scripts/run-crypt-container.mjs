import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.BACKMYGIT_TEST_IMAGE || 'backmygit:release-candidate';
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backmygit-crypt-'));
const dataRoot = path.join(temporaryRoot, 'data');
const backupRoot = path.join(temporaryRoot, 'backups');
const remoteRoot = path.join(temporaryRoot, 'remote-parent');
const configFile = path.join(temporaryRoot, 'rclone.conf');
for (const directory of [dataRoot, backupRoot, remoteRoot]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o777 });
  fs.chmodSync(directory, 0o777);
}
fs.writeFileSync(configFile, '[local_test]\ntype = local\nnounc = true\n', { mode: 0o644 });

try {
  const result = spawnSync('docker', [
    'run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--user', `${uid}:${gid}`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,uid=${uid},gid=${gid},mode=0700`,
    '-e', 'DATA_DIR=/data', '-e', 'BACKUP_ROOT=/backups', '-e', 'RCLONE_CONFIG_FILE=/config/rclone.conf',
    '-v', `${dataRoot}:/data`, '-v', `${backupRoot}:/backups`, '-v', `${remoteRoot}:/remote-parent`,
    '-v', `${configFile}:/config/rclone.conf:ro`,
    '-v', `${path.join(repositoryRoot, 'scripts', 'crypt-container-test.mjs')}:/app/crypt-container-test.mjs:ro`,
    '--workdir', '/remote-parent', '--entrypoint', 'node', image, '/app/crypt-container-test.mjs',
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
