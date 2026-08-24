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
}

export interface ClaimedTransfer { id: string; replica_id: string; attempts: number }

export function claimTransfer(workerId: string): ClaimedTransfer | undefined {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const row = db.prepare(`SELECT id,replica_id,attempts FROM transfer_jobs
      WHERE (status='queued' OR (status='retry_wait' AND next_attempt_at<=?))
      ORDER BY priority DESC,created_at LIMIT 1`).get(now) as ClaimedTransfer | undefined;
    if (!row) return undefined;
    const lease = new Date(Date.now() + config.workerLeaseMs).toISOString();
    const claimed = db.prepare(`UPDATE transfer_jobs SET status='running',attempts=attempts+1,claimed_by=?,
      started_at=COALESCE(started_at,?),heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND status IN ('queued','retry_wait')`)
      .run(workerId, now, now, lease, now, row.id);
    if (!claimed.changes) return undefined;
    const attempt = row.attempts + 1;
    db.prepare('INSERT INTO transfer_attempts(job_id,attempt,started_at) VALUES(?,?,?)').run(row.id, attempt, now);
    db.prepare("UPDATE backup_replicas SET status='packing',last_error=NULL,updated_at=? WHERE id=?").run(now, row.replica_id);
    return { ...row, attempts: attempt };
  })();
}

export function heartbeatTransfer(jobId: string, workerId: string, progress?: { bytes: number; totalBytes?: number; speed?: number }): void {
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + config.workerLeaseMs).toISOString();
  db.prepare(`UPDATE transfer_jobs SET heartbeat_at=?,lease_expires_at=?,bytes_transferred=COALESCE(?,bytes_transferred),
    bytes_total=COALESCE(?,bytes_total),speed_bps=COALESCE(?,speed_bps),progress_updated_at=?,updated_at=?
    WHERE id=? AND status='running' AND claimed_by=?`).run(
      now, lease, progress?.bytes ?? null, progress?.totalBytes ?? null, progress?.speed ?? null,
      progress ? now : null, now, jobId, workerId,
    );
}

export function setReplicaTransferStatus(replicaId: string, status: 'packing' | 'uploading' | 'verifying'): void {
  db.prepare('UPDATE backup_replicas SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), replicaId);
}

export function completeTransfer(jobId: string, replicaId: string, artifact: { size_bytes: number; sha256: string }): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    const job = db.prepare('SELECT attempts FROM transfer_jobs WHERE id=?').get(jobId) as { attempts: number };
    db.prepare(`UPDATE transfer_jobs SET status='success',bytes_total=?,bytes_transferred=?,speed_bps=NULL,
      completed_at=?,claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?`)
      .run(artifact.size_bytes, artifact.size_bytes, now, now, jobId);
    db.prepare(`UPDATE backup_replicas SET status='verified',size_bytes=?,sha256=?,verified_at=?,last_error=NULL,updated_at=? WHERE id=?`)
      .run(artifact.size_bytes, artifact.sha256, now, now, replicaId);
    db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome='success',bytes_transferred=?
      WHERE job_id=? AND attempt=?`).run(now, artifact.size_bytes, jobId, job.attempts);
  })();
}

export function classifyTransferError(error: unknown): 'auth' | 'quota' | 'timeout' | 'network' | 'unknown' {
  const detail = String((error as any)?.message || error).toLowerCase();
  if (/oauth|unauthori[sz]ed|invalid.?grant|invalid.?token|access.?denied|authentication/.test(detail)) return 'auth';
  if (/quota|rate.?limit|too many requests|insufficient storage|storage full/.test(detail)) return 'quota';
  if (/timed? ?out|deadline/.test(detail)) return 'timeout';
  if (/network|connection|econn|temporary|unavailable|dns|tls/.test(detail)) return 'network';
  return 'unknown';
}

export function failTransfer(jobId: string, replicaId: string, error: unknown): { terminal: boolean; nextAttemptAt?: string; code: string } {
  const now = new Date();
  const detail = String((error as any)?.message || error || 'Transfer failed').slice(0, 8000);
  const code = classifyTransferError(error);
  return db.transaction(() => {
    const job = db.prepare('SELECT attempts FROM transfer_jobs WHERE id=?').get(jobId) as { attempts: number };
    const terminal = job.attempts >= config.transferMaxAttempts;
    const delay = Math.min(6 * 60 * 60_000, 15_000 * (2 ** Math.max(0, job.attempts - 1)));
    const jitter = Math.floor(delay * (0.75 + Math.random() * 0.5));
    const nextAttemptAt = terminal ? undefined : new Date(now.getTime() + jitter).toISOString();
    db.prepare(`UPDATE transfer_jobs SET status=?,next_attempt_at=?,error_code=?,error=?,completed_at=?,
      claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?`).run(
        terminal ? 'failed' : 'retry_wait', nextAttemptAt || null, code, detail,
        terminal ? now.toISOString() : null, now.toISOString(), jobId,
      );
    db.prepare('UPDATE backup_replicas SET status=?,last_error=?,updated_at=? WHERE id=?')
      .run(terminal ? 'failed' : 'retry_wait', detail, now.toISOString(), replicaId);
    db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome=?,error_code=?,error=?
      WHERE job_id=? AND attempt=?`).run(now.toISOString(), terminal ? 'failed' : 'retry', code, detail, jobId, job.attempts);
    return { terminal, nextAttemptAt, code };
  })();
}

export function recoverExpiredTransfers(): number {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id,replica_id,attempts FROM transfer_jobs WHERE status='running'
      AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).all(now) as Array<{ id: string; replica_id: string; attempts: number }>;
    for (const row of rows) {
      db.prepare(`UPDATE transfer_jobs SET status='queued',claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
        error_code='interrupted',error='Recovered after an interrupted worker',updated_at=? WHERE id=?`).run(now, row.id);
      db.prepare("UPDATE backup_replicas SET status='queued',last_error='Recovered after an interrupted worker',updated_at=? WHERE id=?").run(now, row.replica_id);
      db.prepare(`UPDATE transfer_attempts SET completed_at=?,outcome='retry',error_code='interrupted',error='Worker lease expired'
        WHERE job_id=? AND attempt=? AND outcome IS NULL`).run(now, row.id, row.attempts);
    }
    return rows.length;
  })();
}

export function retryTransfer(jobId: string): void {
  const now = new Date().toISOString();
  const job = db.prepare(`SELECT j.*,r.id replica_id FROM transfer_jobs j JOIN backup_replicas r ON r.id=j.replica_id
    WHERE j.id=? AND j.status='failed'`).get(jobId) as any;
  if (!job) throw Object.assign(new Error('Failed transfer not found'), { status: 404 });
  db.transaction(() => {
    db.prepare(`UPDATE transfer_jobs SET status='queued',attempts=0,next_attempt_at=NULL,error_code=NULL,error=NULL,
      completed_at=NULL,bytes_transferred=0,speed_bps=NULL,updated_at=? WHERE id=?`).run(now, jobId);
    db.prepare("UPDATE backup_replicas SET status='queued',last_error=NULL,updated_at=? WHERE id=?").run(now, job.replica_id);
  })();
}
