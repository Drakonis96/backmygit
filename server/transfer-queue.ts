import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { branchDirectory, repositoryDirectory } from './paths.js';

export function enqueueSnapshotReplicas(snapshotId: number): number {
  const snapshot = db.prepare(`SELECT s.*,r.owner,r.name repository,br.name branch FROM snapshots s
    JOIN repositories r ON r.id=s.repository_id JOIN branches br ON br.id=s.branch_id WHERE s.id=?`).get(snapshotId) as any;
  if (!snapshot) throw new Error('Snapshot not found');
  const assignments = db.prepare(`SELECT a.*,t.root_path FROM target_assignments a JOIN storage_targets t ON t.id=a.target_id
    WHERE a.scope_type='global' AND a.scope_key='global' AND a.enabled=1 AND t.enabled=1 AND t.kind='rclone'`).all() as any[];
  const timestamp = String(snapshot.completed_at).replace('T', '_').replaceAll(':', '-').replace(/\.\d{3}Z$/, '');
  const relative = [
    repositoryDirectory(snapshot.owner, snapshot.repository),
    branchDirectory(snapshot.branch),
    `${timestamp}_${String(snapshot.commit_sha).slice(0, 12)}.tar.zst`,
  ].join('/');
  const now = new Date().toISOString();
  return db.transaction(() => {
    let queued = 0;
    for (const assignment of assignments) {
      const replicaId = randomUUID();
      const inserted = db.prepare(`INSERT OR IGNORE INTO backup_replicas(
        id,snapshot_id,target_id,status,location,required,created_at,updated_at)
        VALUES(?,? ,?,'queued',?,?,?,?)`).run(
          replicaId, snapshotId, assignment.target_id, relative, assignment.required, now, now,
        );
      if (!inserted.changes) continue;
      db.prepare(`INSERT INTO transfer_jobs(id,replica_id,operation,status,priority,attempts,bytes_transferred,created_at,updated_at)
        VALUES(?,?,'upload','queued',0,0,0,?,?)`).run(randomUUID(), replicaId, now, now);
      queued++;
    }
    return queued;
  }).immediate();
}

export interface ClaimedTransfer { id: string; replica_id: string; attempts: number; operation: 'upload' | 'verify' | 'download' | 'delete' }

function queueReplicaDeletion(replicaId: string, now: string): boolean {
  const replica = db.prepare("SELECT id FROM backup_replicas WHERE id=? AND target_id!='local' AND status!='deleted'").get(replicaId);
  if (!replica) return false;
  const inserted = db.prepare(`INSERT OR IGNORE INTO transfer_jobs(id,replica_id,operation,status,priority,attempts,bytes_transferred,created_at,updated_at)
    VALUES(?,?,'delete','queued',10,0,0,?,?)`).run(randomUUID(), replicaId, now, now);
  if (!inserted.changes) return false;
  db.prepare("UPDATE backup_replicas SET status='deleting',last_error=NULL,deletion_requested_at=COALESCE(deletion_requested_at,?),updated_at=? WHERE id=?")
    .run(now, now, replicaId);
  return true;
}

export function enqueueReplicaDeletion(replicaId: string): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.prepare("UPDATE backup_replicas SET deletion_requested_at=COALESCE(deletion_requested_at,?),updated_at=? WHERE id=? AND target_id!='local'")
      .run(now, now, replicaId);
    return queueReplicaDeletion(replicaId, now);
  }).immediate();
}

export function enqueueSnapshotRemoteDeletions(snapshotId: number): number {
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.prepare('UPDATE snapshots SET remote_delete_requested=1,deletion_requested_at=COALESCE(deletion_requested_at,?) WHERE id=?')
      .run(now, snapshotId);
    const replicas = db.prepare("SELECT id FROM backup_replicas WHERE snapshot_id=? AND target_id!='local' AND status!='deleted'")
      .all(snapshotId) as Array<{ id: string }>;
    let queued = 0;
    for (const replica of replicas) {
      db.prepare('UPDATE backup_replicas SET deletion_requested_at=COALESCE(deletion_requested_at,?),updated_at=? WHERE id=?')
        .run(now, now, replica.id);
      db.prepare(`UPDATE transfer_jobs SET status='cancelled',completed_at=?,error_code='cancelled',
        error='Cancelled because remote deletion was requested',next_attempt_at=NULL,updated_at=?
        WHERE replica_id=? AND operation='upload' AND status IN ('queued','retry_wait')`).run(now, now, replica.id);
      const running = db.prepare("SELECT 1 FROM transfer_jobs WHERE replica_id=? AND operation='upload' AND status='running'").get(replica.id);
      if (!running && queueReplicaDeletion(replica.id, now)) queued++;
    }
    return queued;
  }).immediate();
}

export function enqueueRestore(snapshotId: number, targetId?: string): { jobId: string; targetId: string } {
  const replica = db.prepare(`SELECT r.id,r.target_id FROM backup_replicas r
    JOIN backup_replicas local ON local.snapshot_id=r.snapshot_id AND local.target_id='local' AND local.status='deleted'
    WHERE r.snapshot_id=? AND r.target_id!='local' AND r.status='verified' ${targetId ? 'AND r.target_id=?' : ''}
    ORDER BY r.verified_at DESC LIMIT 1`).get(...(targetId ? [snapshotId, targetId] : [snapshotId])) as { id: string; target_id: string } | undefined;
  if (!replica) throw Object.assign(new Error('No verified remote replica is available for restoration'), { status: 409 });
  const existing = db.prepare("SELECT id FROM transfer_jobs WHERE replica_id=? AND operation='download' AND status IN ('queued','running','retry_wait')")
    .get(replica.id) as { id: string } | undefined;
  if (existing) return { jobId: existing.id, targetId: replica.target_id };
  const jobId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO transfer_jobs(id,replica_id,operation,status,priority,attempts,bytes_total,bytes_transferred,created_at,updated_at)
    SELECT ?,id,'download','queued',20,0,size_bytes,0,?,? FROM backup_replicas WHERE id=?`).run(jobId, now, now, replica.id);
  return { jobId, targetId: replica.target_id };
}

export function claimTransfer(workerId: string): ClaimedTransfer | undefined {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const row = db.prepare(`SELECT j.id,j.replica_id,j.attempts,j.operation FROM transfer_jobs j
      JOIN backup_replicas r ON r.id=j.replica_id
      WHERE (j.status='queued' OR (j.status='retry_wait' AND j.next_attempt_at<=?))
        AND (j.operation!='upload' OR r.deletion_requested_at IS NULL)
      ORDER BY j.priority DESC,j.created_at LIMIT 1`).get(now) as ClaimedTransfer | undefined;
    if (!row) return undefined;
    const lease = new Date(Date.now() + config.workerLeaseMs).toISOString();
    const claimed = db.prepare(`UPDATE transfer_jobs SET status='running',attempts=attempts+1,claimed_by=?,
      started_at=COALESCE(started_at,?),heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND status IN ('queued','retry_wait')`)
      .run(workerId, now, now, lease, now, row.id);
    if (!claimed.changes) return undefined;
    const attempt = row.attempts + 1;
    db.prepare('INSERT INTO transfer_attempts(job_id,attempt,started_at) VALUES(?,?,?)').run(row.id, attempt, now);
    if (row.operation === 'upload')
      db.prepare("UPDATE backup_replicas SET status='packing',last_error=NULL,updated_at=? WHERE id=?").run(now, row.replica_id);
    else if (row.operation === 'delete')
      db.prepare("UPDATE backup_replicas SET status='deleting',last_error=NULL,updated_at=? WHERE id=?").run(now, row.replica_id);
    return { ...row, attempts: attempt };
  })();
}

export function heartbeatTransfer(jobId: string, workerId: string, attempt: number, progress?: { bytes: number; totalBytes?: number; speed?: number }): void {
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + config.workerLeaseMs).toISOString();
  db.prepare(`UPDATE transfer_jobs SET heartbeat_at=?,lease_expires_at=?,bytes_transferred=COALESCE(?,bytes_transferred),
    bytes_total=COALESCE(?,bytes_total),speed_bps=COALESCE(?,speed_bps),progress_updated_at=?,updated_at=?
    WHERE id=? AND status='running' AND claimed_by=? AND attempts=?`).run(
      now, lease, progress?.bytes ?? null, progress?.totalBytes ?? null, progress?.speed ?? null,
      progress ? now : null, now, jobId, workerId, attempt,
    );
}

export function setReplicaTransferStatus(jobId: string, replicaId: string, workerId: string, attempt: number, status: 'packing' | 'uploading' | 'verifying'): boolean {
  const now = new Date().toISOString();
  return db.prepare(`UPDATE backup_replicas SET status=?,updated_at=? WHERE id=? AND deletion_requested_at IS NULL
    AND EXISTS(SELECT 1 FROM transfer_jobs WHERE id=? AND replica_id=? AND status='running' AND claimed_by=? AND attempts=?)`)
    .run(status, now, replicaId, jobId, replicaId, workerId, attempt).changes === 1;
}

export function transferClaimIsActive(jobId: string, workerId: string, attempt: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM transfer_jobs WHERE id=? AND status='running' AND claimed_by=? AND attempts=?")
    .get(jobId, workerId, attempt));
}

export function completeTransfer(jobId: string, replicaId: string, workerId: string, attempt: number, artifact: { size_bytes: number; sha256: string }): { accepted: boolean; deletionRequested: boolean } {
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const updated = db.prepare(`UPDATE transfer_jobs SET status='success',bytes_total=?,bytes_transferred=?,speed_bps=NULL,
      completed_at=?,claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=?
      WHERE id=? AND status='running' AND claimed_by=? AND attempts=?`)
      .run(artifact.size_bytes, artifact.size_bytes, now, now, jobId, workerId, attempt);
    if (!updated.changes) return { accepted: false, deletionRequested: false };
    db.prepare(`UPDATE backup_replicas SET status='verified',size_bytes=?,sha256=?,verified_at=?,last_error=NULL,updated_at=? WHERE id=?`)
      .run(artifact.size_bytes, artifact.sha256, now, now, replicaId);
    db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome='success',bytes_transferred=?
      WHERE job_id=? AND attempt=? AND outcome IS NULL`).run(now, artifact.size_bytes, jobId, attempt);
    const deletionRequested = Boolean(db.prepare('SELECT deletion_requested_at FROM backup_replicas WHERE id=? AND deletion_requested_at IS NOT NULL').get(replicaId));
    return { accepted: true, deletionRequested };
  }).immediate();
  if (result.accepted && result.deletionRequested) enqueueReplicaDeletion(replicaId);
  return result;
}

export function completeClaimedTransfer(
  jobId: string,
  workerId: string,
  attempt: number,
  bytesTransferred: number | undefined,
  updateReplica: (now: string) => void,
): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const updated = db.prepare(`UPDATE transfer_jobs SET status='success',bytes_transferred=COALESCE(?,bytes_transferred),
      speed_bps=NULL,completed_at=?,claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=?
      WHERE id=? AND status='running' AND claimed_by=? AND attempts=?`)
      .run(bytesTransferred ?? null, now, now, jobId, workerId, attempt);
    if (!updated.changes) return false;
    updateReplica(now);
    db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome='success',bytes_transferred=COALESCE(?,bytes_transferred)
      WHERE job_id=? AND attempt=? AND outcome IS NULL`).run(now, bytesTransferred ?? null, jobId, attempt);
    return true;
  }).immediate();
}

export function classifyTransferError(error: unknown): 'auth' | 'quota' | 'timeout' | 'network' | 'unknown' {
  const detail = String((error as any)?.message || error).toLowerCase();
  if (/oauth|unauthori[sz]ed|invalid.?grant|invalid.?token|access.?denied|authentication/.test(detail)) return 'auth';
  if (/quota|rate.?limit|too many requests|insufficient storage|storage full/.test(detail)) return 'quota';
  if (/timed? ?out|deadline/.test(detail)) return 'timeout';
  if (/network|connection|econn|temporary|unavailable|dns|tls/.test(detail)) return 'network';
  return 'unknown';
}

export function failTransfer(jobId: string, replicaId: string, workerId: string, attempt: number, error: unknown, affectReplica = true): { accepted: boolean; terminal: boolean; nextAttemptAt?: string; code: string; deletionRequested: boolean } {
  const now = new Date();
  const detail = String((error as any)?.message || error || 'Transfer failed').slice(0, 8000);
  const code = classifyTransferError(error);
  const result = db.transaction(() => {
    const job = db.prepare("SELECT attempts FROM transfer_jobs WHERE id=? AND status='running' AND claimed_by=? AND attempts=?")
      .get(jobId, workerId, attempt) as { attempts: number } | undefined;
    if (!job) return { accepted: false, terminal: false, code, deletionRequested: false };
    const deletionRequested = Boolean(db.prepare('SELECT 1 FROM backup_replicas WHERE id=? AND deletion_requested_at IS NOT NULL').get(replicaId));
    const terminal = deletionRequested || job.attempts >= config.transferMaxAttempts;
    const delay = Math.min(6 * 60 * 60_000, 15_000 * (2 ** Math.max(0, job.attempts - 1)));
    const jitter = Math.floor(delay * (0.75 + Math.random() * 0.5));
    const nextAttemptAt = terminal ? undefined : new Date(now.getTime() + jitter).toISOString();
    db.prepare(`UPDATE transfer_jobs SET status=?,next_attempt_at=?,error_code=?,error=?,completed_at=?,
      claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=?
      WHERE id=? AND status='running' AND claimed_by=? AND attempts=?`).run(
        deletionRequested ? 'cancelled' : terminal ? 'failed' : 'retry_wait', deletionRequested ? null : nextAttemptAt || null, code, detail,
        terminal ? now.toISOString() : null, now.toISOString(), jobId, workerId, attempt,
      );
    if (affectReplica) db.prepare('UPDATE backup_replicas SET status=?,last_error=?,updated_at=? WHERE id=?')
      .run(deletionRequested ? 'failed' : terminal ? 'failed' : 'retry_wait', detail, now.toISOString(), replicaId);
    db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome=?,error_code=?,error=?
      WHERE job_id=? AND attempt=? AND outcome IS NULL`).run(now.toISOString(), deletionRequested ? 'cancelled' : terminal ? 'failed' : 'retry', code, detail, jobId, job.attempts);
    return { accepted: true, terminal, nextAttemptAt: deletionRequested ? undefined : nextAttemptAt, code, deletionRequested };
  }).immediate();
  if (result.accepted && result.deletionRequested) enqueueReplicaDeletion(replicaId);
  return result;
}

export function recoverExpiredTransfers(): number {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const rows = db.prepare(`SELECT j.id,j.replica_id,j.attempts,j.operation,r.deletion_requested_at FROM transfer_jobs j
      JOIN backup_replicas r ON r.id=j.replica_id WHERE j.status='running'
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=?)`).all(now) as Array<{ id: string; replica_id: string; attempts: number; operation: string; deletion_requested_at?: string }>;
    for (const row of rows) {
      const cancelUpload = row.operation === 'upload' && Boolean(row.deletion_requested_at);
      db.prepare(`UPDATE transfer_jobs SET status=?,claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,completed_at=?,
        error_code='interrupted',error='Recovered after an interrupted worker',updated_at=? WHERE id=?`)
        .run(cancelUpload ? 'cancelled' : 'queued', cancelUpload ? now : null, now, row.id);
      if (row.operation !== 'download') db.prepare("UPDATE backup_replicas SET status=?,last_error='Recovered after an interrupted worker',updated_at=? WHERE id=?")
        .run(row.operation === 'delete' ? 'deleting' : cancelUpload ? 'failed' : 'queued', now, row.replica_id);
      db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome=?,error_code='interrupted',error='Worker lease expired'
        WHERE job_id=? AND attempt=? AND outcome IS NULL`).run(now, cancelUpload ? 'cancelled' : 'retry', row.id, row.attempts);
      if (cancelUpload) queueReplicaDeletion(row.replica_id, now);
    }
    return rows.length;
  })();
}

export function retryTransfer(jobId: string): void {
  const now = new Date().toISOString();
  const job = db.prepare(`SELECT j.*,r.id replica_id,r.deletion_requested_at FROM transfer_jobs j JOIN backup_replicas r ON r.id=j.replica_id
    WHERE j.id=? AND j.status='failed'`).get(jobId) as any;
  if (!job) throw Object.assign(new Error('Failed transfer not found'), { status: 404 });
  if (job.operation === 'upload' && job.deletion_requested_at)
    throw Object.assign(new Error('This replica is pending deletion and cannot be uploaded again'), { status: 409 });
  db.transaction(() => {
    db.prepare(`UPDATE transfer_jobs SET status='queued',attempts=0,next_attempt_at=NULL,error_code=NULL,error=NULL,
      completed_at=NULL,bytes_transferred=0,speed_bps=NULL,updated_at=? WHERE id=?`).run(now, jobId);
    if (job.operation !== 'download') db.prepare("UPDATE backup_replicas SET status=?,last_error=NULL,updated_at=? WHERE id=?")
      .run(job.operation === 'delete' ? 'deleting' : 'queued', now, job.replica_id);
  })();
}
