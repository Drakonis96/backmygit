import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { getSecret } from './secrets.js';
import { assertRemoteName, renderRcloneConfig, type ManagedRcloneConfig } from './rclone-config.js';

export { assertRemoteName, remotePath, renderRcloneConfig } from './rclone-config.js';
export type { ManagedRcloneConfig } from './rclone-config.js';

const exec = promisify(execFile);

async function managedConfigPath(connectionId: string, remoteName: string): Promise<{ directory: string; file: string }> {
  const remote = await getSecret<ManagedRcloneConfig>('connection', connectionId, 'rclone-config');
  if (!remote) throw new Error('Managed rclone credentials are unavailable');
  const temporaryBase = path.join(config.dataDir, 'tmp');
  await fs.mkdir(temporaryBase, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(temporaryBase, 'rclone-'));
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, 'rclone.conf');
  await fs.writeFile(file, renderRcloneConfig(remoteName, remote), { flag: 'wx', mode: 0o600 });
  return { directory, file };
}

export async function withRcloneConfig<T>(connection: {
  id: string;
  remote_name: string;
  managed: number;
}, callback: (configPath: string) => Promise<T>): Promise<T> {
  assertRemoteName(connection.remote_name);
  if (!connection.managed) {
    const stat = await fs.lstat(config.rcloneExternalConfig);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('External rclone config must be a regular file');
    return callback(config.rcloneExternalConfig);
  }
  const temporary = await managedConfigPath(connection.id, connection.remote_name);
  try {
    return await callback(temporary.file);
  } finally {
    await fs.rm(temporary.directory, { recursive: true, force: true });
  }
}

export async function runRclone(
  args: string[],
  options: { configPath?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const home = path.join(config.dataDir, 'rclone-home');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const commandArgs = [
    ...(options.configPath ? ['--config', options.configPath] : []),
    '--ask-password=false',
    '--log-format=date,time',
    ...args,
  ];
  try {
    return await exec(config.rcloneBinary, commandArgs, {
      timeout: options.timeoutMs || config.rcloneTimeoutMs,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        LANG: 'C.UTF-8',
      },
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || 'rclone failed').slice(0, 8000);
    throw Object.assign(new Error(detail), { code: error?.code, killed: error?.killed });
  }
}

export async function rcloneVersion(): Promise<string> {
  const { stdout } = await runRclone(['version'], { timeoutMs: 30_000 });
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!/^rclone v\d+\.\d+\.\d+/.test(firstLine)) throw new Error('Unable to validate the installed rclone binary');
  return firstLine;
}

export const platformArchitecture = `${os.platform()}/${os.arch()}`;
