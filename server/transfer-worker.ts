import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db } from './db.js';
import { ensureArtifact, removeArtifactIfIdle, type ReadyArtifact } from './artifacts.js';
import { remotePath, runRclone, runRcloneStreaming, withTargetRcloneConfig } from './rclone.js';
import { isWithin } from './paths.js';
import {
  claimTransfer,
  completeTransfer,
  failTransfer,
  heartbeatTransfer,
  recoverExpiredTransfers,
  setReplicaTransferStatus,
} from './transfer-queue.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);
const transferWorkerId = `transfer-${process.pid}-${randomUUID()}`;
let active = 0;
let timer: NodeJS.Timeout | undefined;
let started = false;

function transferContext(jobId: string): any {
  const row = db.prepare(`SELECT j.id job_id,j.replica_id,j.attempts,r.location replica_location,r.snapshot_id,
    s.commit_sha,t.id target_id,t.root_path,t.encryption_mode,c.id connection_id,c.remote_name,c.managed,
    lr.location local_source
    FROM transfer_jobs j JOIN backup_replicas r ON r.id=j.replica_id
    JOIN snapshots s ON s.id=r.snapshot_id JOIN storage_targets t ON t.id=r.target_id
    JOIN cloud_connections c ON c.id=t.connection_id
    JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified'
    WHERE j.id=? AND j.operation='upload'`).get(jobId);
  if (!row) throw new Error('Transfer context is unavailable');
  return row;
}

async function remoteSha256(configPath: string, remote: string): Promise<string | undefined> {
  try {
    const { stdout } = await runRclone(['hashsum', 'SHA-256', '--download', remote], { configPath, timeoutMs: config.rcloneTimeoutMs });
    const match = stdout.match(/^([0-9a-fA-F]{64})\s/m);
    return match?.[1].toLowerCase();
  } catch {
    return undefined;
  }
}

async function upload(jobId: string, replicaId: string): Promise<{ artifact: ReadyArtifact; snapshotId: number }> {
  const context = transferContext(jobId);
  const artifact = await ensureArtifact(context.snapshot_id, context.local_source);
  heartbeatTransfer(jobId, transferWorkerId, { bytes: 0, totalBytes: artifact.size_bytes, speed: 0 });
  return withTargetRcloneConfig(
    { id: context.connection_id, remote_name: context.remote_name, managed: context.managed },
    { id: context.target_id, root_path: context.root_path, encryption_mode: context.encryption_mode },
    async targetConfig => {
      const destination = remotePath(targetConfig.remoteName, targetConfig.rootPath, context.replica_location);
      const partial = `${destination}.partial-${jobId}`;
      try {
        const existingHash = await remoteSha256(targetConfig.configPath, destination);
        if (existingHash !== artifact.sha256) {
          setReplicaTransferStatus(replicaId, 'uploading');
          let lastProgressUpdate = 0;
          await runRcloneStreaming([
            'copyto', artifact.path, partial,
            '--retries', '1', '--low-level-retries', '2',
          ], {
            configPath: targetConfig.configPath,
            onProgress: progress => {
              const now = Date.now();
              if (now - lastProgressUpdate < 750 && progress.bytes < artifact.size_bytes) return;
              lastProgressUpdate = now;
              heartbeatTransfer(jobId, transferWorkerId, {
                bytes: Math.min(progress.bytes, artifact.size_bytes),
                totalBytes: artifact.size_bytes,
                speed: progress.speed,
              });
            },
          });
          setReplicaTransferStatus(replicaId, 'verifying');
          const partialHash = await remoteSha256(targetConfig.configPath, partial);
          if (partialHash !== artifact.sha256) throw new Error('Remote SHA-256 verification failed');
          await runRclone(['moveto', partial, destination, '--retries', '1', '--low-level-retries', '2'], {
            configPath: targetConfig.configPath,
          });
        } else {
          setReplicaTransferStatus(replicaId, 'verifying');
        }
        const publishedHash = await remoteSha256(targetConfig.configPath, destination);
        if (publishedHash !== artifact.sha256) throw new Error('Published remote SHA-256 verification failed');
        return { artifact, snapshotId: context.snapshot_id };
      } catch (error) {
        await runRclone(['deletefile', partial], { configPath: targetConfig.configPath, timeoutMs: 60_000 }).catch(() => undefined);
        throw error;
      }
    },
  );
}

function remoteTransferContext(jobId: string): any {
  const row = db.prepare(`SELECT j.id job_id,j.operation,j.replica_id,r.location replica_location,r.snapshot_id,
    r.sha256,r.size_bytes,s.commit_sha,s.repository_id,s.branch_id,t.id target_id,t.root_path,t.encryption_mode,
    c.id connection_id,c.remote_name,c.managed,lr.id local_replica_id,lr.location local_destination,lr.size_bytes local_size_bytes,
    repo.owner,repo.name repository,br.name branch
    FROM transfer_jobs j JOIN backup_replicas r ON r.id=j.replica_id
    JOIN snapshots s ON s.id=r.snapshot_id JOIN storage_targets t ON t.id=r.target_id
    JOIN cloud_connections c ON c.id=t.connection_id
    JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local'
    JOIN repositories repo ON repo.id=s.repository_id JOIN branches br ON br.id=s.branch_id
    WHERE j.id=? AND j.operation IN ('download','delete')`).get(jobId);
  if (!row) throw new Error('Remote transfer context is unavailable');
  return row;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close().catch(() => undefined); }
  return hash.digest('hex');
}

async function restore(jobId: string): Promise<number> {
  const context = remoteTransferContext(jobId);
  if (!context.sha256 || !/^[0-9a-f]{64}$/.test(context.sha256)) throw new Error('The remote replica has no trusted SHA-256');
  if (!isWithin(config.backupRoot, context.local_destination)) throw new Error('Restore destination is outside the backup root');
  const temporaryArchive = path.join(config.backupRoot, '.tmp', `restore-${jobId}.tar.zst`);
  const temporaryDirectory = path.join(config.backupRoot, '.tmp', `restore-${jobId}`);
  await fs.mkdir(path.dirname(temporaryArchive), { recursive: true, mode: 0o700 });
  await fs.rm(temporaryArchive, { force: true });
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  try {
    const filesystem = await fs.statfs(config.backupRoot);
    const freeBytes = filesystem.bavail * filesystem.bsize;
    if (freeBytes < Number(context.local_size_bytes || 0) + config.minFreeBytes)
      throw new Error('Insufficient free space to restore this snapshot safely');
    await withTargetRcloneConfig(
      { id: context.connection_id, remote_name: context.remote_name, managed: context.managed },
      { id: context.target_id, root_path: context.root_path, encryption_mode: context.encryption_mode },
      async targetConfig => {
        const source = remotePath(targetConfig.remoteName, targetConfig.rootPath, context.replica_location);
        await runRcloneStreaming(['copyto', source, temporaryArchive, '--retries', '1', '--low-level-retries', '2'], {
          configPath: targetConfig.configPath,
          onProgress: progress => heartbeatTransfer(jobId, transferWorkerId, {
            bytes: Math.min(progress.bytes, context.size_bytes || progress.bytes),
            totalBytes: context.size_bytes || progress.totalBytes,
            speed: progress.speed,
          }),
        });
      },
    );
    const downloaded = await fs.stat(temporaryArchive);
    if (downloaded.size !== context.size_bytes || await sha256File(temporaryArchive) !== context.sha256)
      throw new Error('Downloaded replica size or SHA-256 verification failed');
    const { stdout: listing } = await exec('tar', ['-tf', temporaryArchive], { timeout: config.rcloneTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
    for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
      const normalized = entry.replace(/^\.\//, '');
      if (path.isAbsolute(normalized) || normalized.split('/').includes('..') || /[\r\n\0]/.test(normalized))
        throw new Error('The replica archive contains an unsafe path');
    }
    await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    await exec('tar', ['-xf', temporaryArchive, '-C', temporaryDirectory], { timeout: config.rcloneTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const metadata = JSON.parse(await fs.readFile(path.join(temporaryDirectory, 'backup-metadata.json'), 'utf8'));
    if (metadata.commitSha !== context.commit_sha || metadata.repository?.owner !== context.owner ||
      metadata.repository?.name !== context.repository || metadata.branch !== context.branch || metadata.status !== 'success')
      throw new Error('Restored backup metadata does not match the snapshot');
    const { stdout: commit } = await exec('git', ['-C', temporaryDirectory, 'rev-parse', 'HEAD'], { timeout: 30_000 });
    if (commit.trim() !== context.commit_sha) throw new Error('Restored repository commit does not match the snapshot');
    try { await fs.lstat(context.local_destination); throw new Error('Restore destination already exists'); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(context.local_destination), { recursive: true });
    await fs.rename(temporaryDirectory, context.local_destination);
    const now = new Date().toISOString();
    db.transaction(() => {
      const job = db.prepare('SELECT attempts FROM transfer_jobs WHERE id=?').get(jobId) as { attempts: number };
      db.prepare(`UPDATE transfer_jobs SET status='success',bytes_transferred=bytes_total,speed_bps=NULL,completed_at=?,
        claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?`).run(now, now, jobId);
      db.prepare(`UPDATE backup_replicas SET status='verified',size_bytes=COALESCE(size_bytes,?),sha256=?,verified_at=?,
        last_error=NULL,deleted_at=NULL,updated_at=? WHERE id=?`).run(context.size_bytes, context.commit_sha, now, now, context.local_replica_id);
      db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome='success',bytes_transferred=COALESCE(?,0)
        WHERE job_id=? AND attempt=?`).run(now, context.size_bytes, jobId, job.attempts);
    })();
    return context.snapshot_id;
  } finally {
    await fs.rm(temporaryArchive, { force: true }).catch(() => undefined);
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeRemote(jobId: string): Promise<number> {
  const context = remoteTransferContext(jobId);
  await withTargetRcloneConfig(
    { id: context.connection_id, remote_name: context.remote_name, managed: context.managed },
    { id: context.target_id, root_path: context.root_path, encryption_mode: context.encryption_mode },
    async targetConfig => {
      const destination = remotePath(targetConfig.remoteName, targetConfig.rootPath, context.replica_location);
      try { await runRclone(['deletefile', destination, '--retries', '1', '--low-level-retries', '2'], { configPath: targetConfig.configPath }); }
      catch (error: any) { if (!/not found|does not exist|object not found/i.test(String(error?.message))) throw error; }
    },
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    const job = db.prepare('SELECT attempts FROM transfer_jobs WHERE id=?').get(jobId) as { attempts: number };
    db.prepare(`UPDATE transfer_jobs SET status='success',completed_at=?,claimed_by=NULL,lease_expires_at=NULL,
      heartbeat_at=NULL,updated_at=? WHERE id=?`).run(now, now, jobId);
    db.prepare("UPDATE backup_replicas SET status='deleted',deleted_at=?,last_error=NULL,updated_at=? WHERE id=?")
      .run(now, now, context.replica_id);
    db.prepare("UPDATE transfer_attempts SET completed_at=?,outcome='success' WHERE job_id=? AND attempt=?")
      .run(now, jobId, job.attempts);
  })();
  return context.snapshot_id;
}

async function execute(job: { id: string; replica_id: string; operation: string }) {
  const heartbeat = setInterval(() => heartbeatTransfer(job.id, transferWorkerId), Math.min(30_000, Math.floor(config.workerLeaseMs / 3)));
  heartbeat.unref();
  let snapshotId: number | undefined;
  try {
    if (job.operation === 'upload') {
      const result = await upload(job.id, job.replica_id);
      snapshotId = result.snapshotId;
      completeTransfer(job.id, job.replica_id, result.artifact);
    } else if (job.operation === 'download') snapshotId = await restore(job.id);
    else if (job.operation === 'delete') snapshotId = await removeRemote(job.id);
    else throw new Error(`Unsupported transfer operation: ${job.operation}`);
  } catch (error) {
    const context = db.prepare(`SELECT r.snapshot_id,t.connection_id FROM backup_replicas r
      JOIN storage_targets t ON t.id=r.target_id WHERE r.id=?`).get(job.replica_id) as any;
    snapshotId = context?.snapshot_id;
    const failure = failTransfer(job.id, job.replica_id, error, job.operation !== 'download');
    if (failure.code === 'auth' && context?.connection_id) {
      db.prepare("UPDATE cloud_connections SET status='reauthorization_required',last_error=?,updated_at=? WHERE id=?")
        .run('Cloud authorization is no longer valid', new Date().toISOString(), context.connection_id);
    }
  } finally {
    clearInterval(heartbeat);
    if (snapshotId) await removeArtifactIfIdle(snapshotId).catch(error => console.error('Artifact cleanup failed', error));
  }
}

async function pump() {
  while (started && active < config.transferConcurrency) {
    const job = claimTransfer(transferWorkerId);
    if (!job) break;
    active++;
    void execute(job).finally(() => { active--; queueMicrotask(pump); });
  }
}

export function startTransferWorker(): void {
  if (started) return;
  recoverExpiredTransfers();
  started = true;
  timer = setInterval(pump, 1500);
  timer.unref();
  void pump();
}

export async function stopTransferWorker(graceMs = 25_000): Promise<void> {
  started = false;
  if (timer) clearInterval(timer);
  timer = undefined;
  const deadline = Date.now() + graceMs;
  while (active > 0 && Date.now() < deadline) await wait(250);
}
