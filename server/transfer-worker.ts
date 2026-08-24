import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { ensureArtifact, removeArtifactIfIdle, type ReadyArtifact } from './artifacts.js';
import { remotePath, runRclone, runRcloneStreaming, withTargetRcloneConfig } from './rclone.js';
import {
  claimTransfer,
  completeTransfer,
  failTransfer,
  heartbeatTransfer,
  recoverExpiredTransfers,
  setReplicaTransferStatus,
} from './transfer-queue.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

async function execute(job: { id: string; replica_id: string }) {
  const heartbeat = setInterval(() => heartbeatTransfer(job.id, transferWorkerId), Math.min(30_000, Math.floor(config.workerLeaseMs / 3)));
  heartbeat.unref();
  let snapshotId: number | undefined;
  try {
    const result = await upload(job.id, job.replica_id);
    snapshotId = result.snapshotId;
    completeTransfer(job.id, job.replica_id, result.artifact);
  } catch (error) {
    const context = db.prepare(`SELECT r.snapshot_id,t.connection_id FROM backup_replicas r
      JOIN storage_targets t ON t.id=r.target_id WHERE r.id=?`).get(job.replica_id) as any;
    snapshotId = context?.snapshot_id;
    const failure = failTransfer(job.id, job.replica_id, error);
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
