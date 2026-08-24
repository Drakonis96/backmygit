import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db } from './db.js';
import { getSecret, getSecretWithRevision, putSecretIfRevision } from './secrets.js';
import { assertRemoteName, normalizeRemoteSubpath, parseRcloneConfig, renderRcloneConfig, type ManagedRcloneConfig } from './rclone-config.js';
import { validateCloudEndpoint } from './cloud-endpoint.js';

export { assertRemoteName, normalizeRemoteSubpath, remotePath, renderRcloneConfig } from './rclone-config.js';
export type { ManagedRcloneConfig } from './rclone-config.js';

const exec = promisify(execFile);
const connectionLockLeaseMs = 5 * 60_000;

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireConnectionLock(connectionId: string): Promise<() => void> {
  const holder = randomUUID();
  const deadline = Date.now() + config.rcloneTimeoutMs;
  while (Date.now() < deadline) {
    const now = new Date();
    const expires = new Date(now.getTime() + connectionLockLeaseMs).toISOString();
    const acquired = db.transaction(() => {
      db.prepare('DELETE FROM connection_locks WHERE connection_id=? AND expires_at<=?').run(connectionId, now.toISOString());
      return db.prepare(`INSERT INTO connection_locks(connection_id,holder,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO NOTHING`).run(
          connectionId, holder, expires, now.toISOString(), now.toISOString(),
        ).changes === 1;
    }).immediate();
    if (acquired) {
      const heartbeat = setInterval(() => {
        const refreshed = new Date();
        db.prepare('UPDATE connection_locks SET expires_at=?,updated_at=? WHERE connection_id=? AND holder=?')
          .run(new Date(refreshed.getTime() + connectionLockLeaseMs).toISOString(), refreshed.toISOString(), connectionId, holder);
      }, Math.floor(connectionLockLeaseMs / 3));
      heartbeat.unref();
      return () => {
        clearInterval(heartbeat);
        db.prepare('DELETE FROM connection_locks WHERE connection_id=? AND holder=?').run(connectionId, holder);
      };
    }
    await pause(250);
  }
  throw new Error('Timed out waiting for exclusive access to the cloud connection');
}

async function managedConfigPath(connectionId: string, remoteName: string): Promise<{ directory: string; file: string; revision: number }> {
  const stored = await getSecretWithRevision<ManagedRcloneConfig>('connection', connectionId, 'rclone-config');
  if (!stored) throw new Error('Managed rclone credentials are unavailable');
  if (stored.value.type === 's3' && stored.value.fields.endpoint)
    stored.value.fields.endpoint = await validateCloudEndpoint(stored.value.fields.endpoint);
  const temporaryBase = path.join(config.dataDir, 'tmp');
  await fs.mkdir(temporaryBase, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(temporaryBase, 'rclone-'));
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, 'rclone.conf');
  await fs.writeFile(file, renderRcloneConfig(remoteName, stored.value), { flag: 'wx', mode: 0o600 });
  return { directory, file, revision: stored.revision };
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
  const release = await acquireConnectionLock(connection.id);
  let temporary: { directory: string; file: string; revision: number } | undefined;
  let callbackError: unknown;
  try {
    temporary = await managedConfigPath(connection.id, connection.remote_name);
    return await callback(temporary.file);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      if (temporary) {
        try {
          const updated = parseRcloneConfig(await fs.readFile(temporary.file, 'utf8'), connection.remote_name);
          // OAuth reauthorization may replace the credentials while a long rclone
          // operation is running. Persist refreshed tokens only if this operation
          // still owns the secret revision it originally loaded.
          const persisted = await putSecretIfRevision('connection', connection.id, 'rclone-config', temporary.revision, updated);
          if (!persisted && callbackError && typeof callbackError === 'object')
            Object.assign(callbackError, { staleCredentials: true });
        } finally {
          await fs.rm(temporary.directory, { recursive: true, force: true });
        }
      }
    } finally {
      release();
    }
  }
}

export async function withTargetRcloneConfig<T>(
  connection: { id: string; remote_name: string; managed: number },
  target: { id: string; root_path: string; encryption_mode: string },
  callback: (context: { configPath: string; remoteName: string; rootPath: string }) => Promise<T>,
): Promise<T> {
  return withRcloneConfig(connection, async baseConfigPath => {
    const rootPath = normalizeRemoteSubpath(target.root_path);
    if (target.encryption_mode !== 'crypt')
      return callback({ configPath: baseConfigPath, remoteName: connection.remote_name, rootPath });
    const crypt = await getSecret<{ password: string; password2: string }>('target', target.id, 'crypt');
    if (!crypt?.password || !crypt?.password2) throw new Error('Target encryption keys are unavailable');
    const stat = await fs.stat(baseConfigPath);
    if (stat.size > 10 * 1024 * 1024) throw new Error('The rclone configuration file is too large');
    const cryptName = assertRemoteName(`bmgcrypt_${target.id.replaceAll('-', '')}`);
    const temporaryBase = path.join(config.dataDir, 'tmp');
    await fs.mkdir(temporaryBase, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(temporaryBase, 'rclone-crypt-'));
    const file = path.join(directory, 'rclone.conf');
    const base = await fs.readFile(baseConfigPath, 'utf8');
    const cryptConfig = renderRcloneConfig(cryptName, {
      type: 'crypt',
      fields: {
        remote: `${connection.remote_name}:${rootPath}`,
        password: crypt.password,
        password2: crypt.password2,
        filename_encryption: 'standard',
        directory_name_encryption: 'true',
      },
    });
    await fs.writeFile(file, `${base.trimEnd()}\n\n${cryptConfig}`, { flag: 'wx', mode: 0o600 });
    try {
      return await callback({ configPath: file, remoteName: cryptName, rootPath: '' });
    } finally {
      try {
        if (connection.managed) {
          const updated = parseRcloneConfig(await fs.readFile(file, 'utf8'), connection.remote_name);
          await fs.writeFile(baseConfigPath, renderRcloneConfig(connection.remote_name, updated), { mode: 0o600 });
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });
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

export async function runRcloneStreaming(
  args: string[],
  options: { configPath: string; timeoutMs?: number; statsInterval?: string; onProgress?: (progress: { bytes: number; totalBytes?: number; speed?: number }) => void },
): Promise<{ stdout: string; stderr: string }> {
  const home = path.join(config.dataDir, 'rclone-home');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(config.rcloneBinary, [
      '--config', options.configPath,
      '--ask-password=false',
      '--use-json-log',
      '--stats', options.statsInterval || '1s',
      '--stats-log-level', 'INFO',
      '--log-level', 'INFO',
      ...args,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, LANG: 'C.UTF-8' },
    });
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    const parseProgress = (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const stats = parsed.stats || parsed;
          const bytes = Number(stats.bytes);
          const totalBytes = Number(stats.totalBytes);
          const speed = Number(stats.speed || stats.speedAvg);
          if (Number.isFinite(bytes)) options.onProgress?.({
            bytes: Math.max(0, Math.floor(bytes)),
            totalBytes: Number.isFinite(totalBytes) ? Math.max(0, Math.floor(totalBytes)) : undefined,
            speed: Number.isFinite(speed) ? Math.max(0, Math.floor(speed)) : undefined,
          });
        } catch { /* ordinary rclone log line */ }
      }
    };
    child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk; parseProgress(chunk); });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs || config.rcloneTimeoutMs);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(timedOut ? 'rclone timed out' : stderr.trim().slice(0, 8000) || 'rclone failed'), { code }));
    });
  });
}

export async function rcloneVersion(): Promise<string> {
  const { stdout } = await runRclone(['version'], { timeoutMs: 30_000 });
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!/^rclone v\d+\.\d+\.\d+/.test(firstLine)) throw new Error('Unable to validate the installed rclone binary');
  return firstLine;
}

export async function obscureRcloneSecret(value: string): Promise<string> {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid secret value');
  const home = path.join(config.dataDir, 'rclone-home');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(config.rcloneBinary, ['obscure', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, LANG: 'C.UTF-8' },
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => { if (stdout.length < 4096) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      const obscured = stdout.trim();
      if (code !== 0 || !obscured || /[\r\n\0]/.test(obscured))
        reject(new Error(stderr.trim() || 'Unable to protect the rclone password'));
      else resolve(obscured);
    });
    child.stdin.end(value);
  });
}

export const platformArchitecture = `${os.platform()}/${os.arch()}`;
