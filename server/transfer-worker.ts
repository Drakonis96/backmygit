import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
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
  completeClaimedTransfer,
  completeTransfer,
  failTransfer,
  heartbeatTransfer,
  recoverExpiredTransfers,
  setReplicaTransferStatus,
  transferClaimIsActive,
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

function assertActiveClaim(jobId: string, attempt: number): void {
  if (!transferClaimIsActive(jobId, transferWorkerId, attempt))
    throw new Error('Transfer lease is no longer active');
}

async function deleteRemoteObject(configPath: string, remote: string): Promise<void> {
  try { await runRclone(['deletefile', remote, '--retries', '1', '--low-level-retries', '2'], { configPath, timeoutMs: 60_000 }); }
  catch (error: any) { if (!/not found|does not exist|object not found/i.test(String(error?.message))) throw error; }
}

async function upload(jobId: string, replicaId: string, attempt: number): Promise<{ artifact: ReadyArtifact; snapshotId: number }> {
  const context = transferContext(jobId);
  const artifact = await ensureArtifact(context.snapshot_id, context.local_source);
  assertActiveClaim(jobId, attempt);
  heartbeatTransfer(jobId, transferWorkerId, attempt, { bytes: 0, totalBytes: artifact.size_bytes, speed: 0 });
  return withTargetRcloneConfig(
    { id: context.connection_id, remote_name: context.remote_name, managed: context.managed },
    { id: context.target_id, root_path: context.root_path, encryption_mode: context.encryption_mode },
    async targetConfig => {
      const destination = remotePath(targetConfig.remoteName, targetConfig.rootPath, context.replica_location);
      const partial = `${destination}.partial-${jobId}-${attempt}`;
      try {
        for (let previous = 1; previous < attempt; previous++)
          await deleteRemoteObject(targetConfig.configPath, `${destination}.partial-${jobId}-${previous}`).catch(() => undefined);
        await deleteRemoteObject(targetConfig.configPath, `${destination}.partial-${jobId}`).catch(() => undefined);
        const existingHash = await remoteSha256(targetConfig.configPath, destination);
        if (existingHash !== artifact.sha256) {
          if (!setReplicaTransferStatus(jobId, replicaId, transferWorkerId, attempt, 'uploading'))
            throw new Error('Transfer lease is no longer active');
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
              heartbeatTransfer(jobId, transferWorkerId, attempt, {
                bytes: Math.min(progress.bytes, artifact.size_bytes),
                totalBytes: artifact.size_bytes,
                speed: progress.speed,
              });
            },
          });
          if (!setReplicaTransferStatus(jobId, replicaId, transferWorkerId, attempt, 'verifying'))
            throw new Error('Transfer lease is no longer active');
          const partialHash = await remoteSha256(targetConfig.configPath, partial);
          if (partialHash !== artifact.sha256) throw new Error('Remote SHA-256 verification failed');
          assertActiveClaim(jobId, attempt);
          await runRclone(['moveto', partial, destination, '--retries', '1', '--low-level-retries', '2'], {
            configPath: targetConfig.configPath,
          });
        } else {
          if (!setReplicaTransferStatus(jobId, replicaId, transferWorkerId, attempt, 'verifying'))
            throw new Error('Transfer lease is no longer active');
        }
        const publishedHash = await remoteSha256(targetConfig.configPath, destination);
        if (publishedHash !== artifact.sha256) throw new Error('Published remote SHA-256 verification failed');
        assertActiveClaim(jobId, attempt);
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

async function validateRestoredDirectory(directory: string, context: any): Promise<void> {
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'backup-metadata.json'), 'utf8'));
  if (metadata.commitSha !== context.commit_sha || metadata.repository?.owner !== context.owner ||
    metadata.repository?.name !== context.repository || metadata.branch !== context.branch || metadata.status !== 'success')
    throw new Error('Restored backup metadata does not match the snapshot');
  const { stdout: commit } = await exec('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeout: 30_000 });
  if (commit.trim() !== context.commit_sha) throw new Error('Restored repository commit does not match the snapshot');
}

async function readOrExtractArchive(archive: string, destination?: string): Promise<string> {
  const zstd = spawn('zstd', ['-dc', archive], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tar = spawn('tar', destination ? ['-xf', '-', '-C', destination] : ['-tf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  zstd.stdout.pipe(tar.stdin);
  let output = '';
  let errors = '';
  tar.stdout.on('data', chunk => {
    if (output.length + chunk.length > 8 * 1024 * 1024) {
      zstd.kill('SIGKILL');
      tar.kill('SIGKILL');
      return;
    }
    output += chunk;
  });
  for (const stream of [zstd.stderr, tar.stderr])
    stream.on('data', chunk => { if (errors.length < 8000) errors += chunk; });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    zstd.kill('SIGKILL');
    tar.kill('SIGKILL');
  }, config.rcloneTimeoutMs);
  try {
    const [zstdCode, tarCode] = await Promise.all([
      new Promise<number | null>((resolve, reject) => { zstd.once('error', reject); zstd.once('close', resolve); }),
      new Promise<number | null>((resolve, reject) => { tar.once('error', reject); tar.once('close', resolve); }),
    ]);
    if (timedOut || zstdCode !== 0 || tarCode !== 0 || output.length > 8 * 1024 * 1024)
      throw new Error(timedOut ? 'Archive processing timed out' : errors.trim() || 'Archive processing failed');
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

async function restore(jobId: string, attempt: number): Promise<number> {
  const context = remoteTransferContext(jobId);
  if (!context.sha256 || !/^[0-9a-f]{64}$/.test(context.sha256)) throw new Error('The remote replica has no trusted SHA-256');
  if (!isWithin(config.backupRoot, context.local_destination)) throw new Error('Restore destination is outside the backup root');
  const temporaryArchive = path.join(config.backupRoot, '.tmp', `restore-${jobId}-${attempt}.tar.zst`);
  const temporaryDirectory = path.join(config.backupRoot, '.tmp', `restore-${jobId}-${attempt}`);
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
          onProgress: progress => heartbeatTransfer(jobId, transferWorkerId, attempt, {
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
    const listing = await readOrExtractArchive(temporaryArchive);
    for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
      const normalized = entry.replace(/^\.\//, '');
      if (path.isAbsolute(normalized) || normalized.split('/').includes('..') || /[\r\n\0]/.test(normalized))
        throw new Error('The replica archive contains an unsafe path');
    }
    await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    await readOrExtractArchive(temporaryArchive, temporaryDirectory);
    await validateRestoredDirectory(temporaryDirectory, context);
    assertActiveClaim(jobId, attempt);
    let destinationExists = false;
    try { await fs.lstat(context.local_destination); destinationExists = true; }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    if (destinationExists) {
      // A fenced-out attempt may have published the verified directory just
      // before losing its lease. Adopt it only after validating it again.
      await validateRestoredDirectory(context.local_destination, context);
    } else {
      await fs.mkdir(path.dirname(context.local_destination), { recursive: true });
      await fs.rename(temporaryDirectory, context.local_destination);
    }
    const completed = completeClaimedTransfer(jobId, transferWorkerId, attempt, context.size_bytes, now => {
      db.prepare(`UPDATE backup_replicas SET status='verified',size_bytes=COALESCE(size_bytes,?),sha256=?,verified_at=?,
        last_error=NULL,deleted_at=NULL,updated_at=? WHERE id=?`).run(context.size_bytes, context.commit_sha, now, now, context.local_replica_id);
      db.prepare('UPDATE snapshots SET deletion_requested_at=NULL,remote_delete_requested=0 WHERE id=?').run(context.snapshot_id);
    });
    if (!completed) throw new Error('Transfer lease is no longer active');
    return context.snapshot_id;
  } finally {
    await fs.rm(temporaryArchive, { force: true }).catch(() => undefined);
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeRemote(jobId: string, attempt: number): Promise<number> {
  const context = remoteTransferContext(jobId);
  await withTargetRcloneConfig(
    { id: context.connection_id, remote_name: context.remote_name, managed: context.managed },
    { id: context.target_id, root_path: context.root_path, encryption_mode: context.encryption_mode },
    async targetConfig => {
      const destination = remotePath(targetConfig.remoteName, targetConfig.rootPath, context.replica_location);
      const uploads = db.prepare("SELECT id,attempts FROM transfer_jobs WHERE replica_id=? AND operation='upload'")
        .all(context.replica_id) as Array<{ id: string; attempts: number }>;
      for (const uploadJob of uploads) {
        await deleteRemoteObject(targetConfig.configPath, `${destination}.partial-${uploadJob.id}`).catch(() => undefined);
        for (let uploadAttempt = 1; uploadAttempt <= uploadJob.attempts; uploadAttempt++)
          await deleteRemoteObject(targetConfig.configPath, `${destination}.partial-${uploadJob.id}-${uploadAttempt}`).catch(() => undefined);
      }
      await deleteRemoteObject(targetConfig.configPath, destination);
    },
  );
  completeClaimedTransfer(jobId, transferWorkerId, attempt, undefined, now => {
    db.prepare("UPDATE backup_replicas SET status='deleted',deleted_at=?,last_error=NULL,updated_at=? WHERE id=?")
      .run(now, now, context.replica_id);
  });
  return context.snapshot_id;
}

async function execute(job: { id: string; replica_id: string; operation: string; attempts: number }) {
  const heartbeat = setInterval(() => heartbeatTransfer(job.id, transferWorkerId, job.attempts), Math.min(30_000, Math.floor(config.workerLeaseMs / 3)));
  heartbeat.unref();
  let snapshotId: number | undefined;
  try {
    if (job.operation === 'upload') {
      const result = await upload(job.id, job.replica_id, job.attempts);
      snapshotId = result.snapshotId;
      completeTransfer(job.id, job.replica_id, transferWorkerId, job.attempts, result.artifact);
    } else if (job.operation === 'download') snapshotId = await restore(job.id, job.attempts);
    else if (job.operation === 'delete') snapshotId = await removeRemote(job.id, job.attempts);
    else throw new Error(`Unsupported transfer operation: ${job.operation}`);
  } catch (error) {
    const context = db.prepare(`SELECT r.snapshot_id,t.connection_id FROM backup_replicas r
      JOIN storage_targets t ON t.id=r.target_id WHERE r.id=?`).get(job.replica_id) as any;
    snapshotId = context?.snapshot_id;
    const failure = failTransfer(job.id, job.replica_id, transferWorkerId, job.attempts, error, job.operation !== 'download');
    if (failure.accepted && failure.code === 'auth' && !(error as any)?.staleCredentials && context?.connection_id) {
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
