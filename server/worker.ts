import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db } from './db.js';
import { branchDirectory, repositoryDirectory, timestampDirectory } from './paths.js';
import { applyRetention } from './retention.js';
import { directorySize } from './storage.js';
import type { BackupMetadata } from './types.js';

const exec = promisify(execFile);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let active = 0;
let timer: NodeJS.Timeout | undefined;
let workerStarted = false;
const workerId = `${process.pid}-${randomUUID()}`;

function leaseExpiry(): string {
  return new Date(Date.now() + config.workerLeaseMs).toISOString();
}

export function enqueueBackup(branchId: number, origin: 'manual' | 'automatic'): { id: string; queued: boolean } {
  const branch = db.prepare(`SELECT br.id, br.enabled, br.configured, r.enabled repository_enabled FROM branches br JOIN repositories r ON r.id=br.repository_id WHERE br.id=?`).get(branchId) as any;
  if (!branch) throw Object.assign(new Error('Branch not found'), { status: 404 });
  if (!branch.enabled || !branch.configured || !branch.repository_enabled) throw Object.assign(new Error('Backups are disabled for this branch'), { status: 409 });
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO runs(id,repository_id,branch_id,status,origin,created_at)
      SELECT ?,repository_id,id,'queued',?,? FROM branches WHERE id=?`).run(id, origin, new Date().toISOString(), branchId);
    if (workerStarted) queueMicrotask(pump);
    return { id, queued: true };
  } catch (error: any) {
    if (String(error.code).includes('SQLITE_CONSTRAINT')) {
      const current = db.prepare("SELECT id FROM runs WHERE branch_id=? AND status IN ('queued','running')").get(branchId) as any;
      return { id: current?.id, queued: false };
    }
    throw error;
  }
}

async function git(args: string[], options: { cwd?: string } = {}) {
  return exec('git', args, { ...options, timeout: config.gitTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

async function freeBytes(): Promise<number> {
  const stat = await fs.statfs(config.backupRoot);
  return stat.bavail * stat.bsize;
}

async function executeRun(runId: string) {
  const row = db.prepare(`SELECT ru.*, br.name branch, r.owner, r.name repository, r.url
    FROM runs ru JOIN branches br ON br.id=ru.branch_id JOIN repositories r ON r.id=ru.repository_id WHERE ru.id=?`).get(runId) as any;
  if (!row) return;
  const started = new Date();
  const tmpPath = path.join(config.backupRoot, '.tmp', runId);
  const parent = path.join(config.backupRoot, repositoryDirectory(row.owner, row.repository), branchDirectory(row.branch));
  const destination = path.join(parent, timestampDirectory(started));
  db.prepare("UPDATE runs SET started_at=?, attempts=attempts+1,heartbeat_at=?,lease_expires_at=? WHERE id=? AND status='running' AND claimed_by=?")
    .run(started.toISOString(), started.toISOString(), leaseExpiry(), runId, workerId);
  const heartbeat = setInterval(() => {
    const now = new Date().toISOString();
    db.prepare("UPDATE runs SET heartbeat_at=?,lease_expires_at=? WHERE id=? AND status='running' AND claimed_by=?")
      .run(now, leaseExpiry(), runId, workerId);
  }, Math.min(30_000, Math.floor(config.workerLeaseMs / 3)));
  heartbeat.unref();
  try {
    await fs.mkdir(path.dirname(tmpPath), { recursive: true });
    await fs.rm(tmpPath, { recursive: true, force: true });
    if (await freeBytes() < config.minFreeBytes) throw new Error(`Insufficient free space: at least ${config.minFreeBytes} bytes must remain`);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(row.url)) throw new Error('Only public HTTPS GitHub repository URLs are accepted');

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await git(['clone', '--single-branch', '--branch', row.branch, '--no-tags', '--', row.url, tmpPath]);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await fs.rm(tmpPath, { recursive: true, force: true });
        if (attempt < 3) await wait(attempt * attempt * 1000);
      }
    }
    if (lastError) throw lastError;
    const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: tmpPath });
    const commitSha = stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commitSha)) throw new Error('Git clone validation returned an invalid commit SHA');
    await git(['fsck', '--connectivity-only', '--no-dangling'], { cwd: tmpPath });
    const completed = new Date();
    const metadata: BackupMetadata = {
      schemaVersion: 1, applicationVersion: config.appVersion,
      repository: { owner: row.owner, name: row.repository, url: row.url },
      branch: row.branch, commitSha, startedAt: started.toISOString(), completedAt: completed.toISOString(),
      status: 'success', origin: row.origin, sizeBytes: 0
    };
    await fs.writeFile(path.join(tmpPath, 'backup-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
    metadata.sizeBytes = await directorySize(tmpPath);
    await fs.writeFile(path.join(tmpPath, 'backup-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
    metadata.sizeBytes = await directorySize(tmpPath);
    await fs.writeFile(path.join(tmpPath, 'backup-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
    if (await freeBytes() < config.minFreeBytes) throw new Error('Backup completed but free-space safety threshold was crossed');
    await fs.mkdir(parent, { recursive: true });
    await fs.rename(tmpPath, destination);
    const exists = await fs.stat(destination);
    if (!exists.isDirectory()) throw new Error('Final backup destination is not a directory');
    const duration = completed.getTime() - started.getTime();
    db.transaction(() => {
      db.prepare(`UPDATE runs SET status='success',completed_at=?,commit_sha=?,size_bytes=?,destination=?,error=NULL,
        claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=?`)
        .run(completed.toISOString(), commitSha, metadata.sizeBytes, destination, runId);
      const snapshot = db.prepare(`INSERT INTO snapshots(repository_id,branch_id,run_id,commit_sha,started_at,completed_at,duration_ms,origin,status,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,'success',?,?) RETURNING id`).get(
          row.repository_id, row.branch_id, runId, commitSha, started.toISOString(), completed.toISOString(), duration,
          row.origin, JSON.stringify(metadata), completed.toISOString(),
        ) as { id: number };
      db.prepare(`INSERT INTO backup_replicas(id,snapshot_id,target_id,status,location,size_bytes,sha256,required,verified_at,created_at,updated_at)
        VALUES(?,?,'local','verified',?,?,?,?,?,?,?)`).run(
          randomUUID(), snapshot.id, destination, metadata.sizeBytes, commitSha, 1,
          completed.toISOString(), completed.toISOString(), completed.toISOString(),
        );
      db.prepare('UPDATE branches SET last_run_at=? WHERE id=?').run(completed.toISOString(), row.branch_id);
    })();
    try {
      await applyRetention(row.branch_id);
    } catch (retentionError) {
      // A cleanup failure must never downgrade a verified, published backup.
      console.error(`Retention cleanup failed for branch ${row.branch_id}`, retentionError);
    }
  } catch (error: any) {
    await fs.rm(tmpPath, { recursive: true, force: true }).catch(() => undefined);
    const completed = new Date().toISOString();
    const detail = [error?.message, error?.stderr].filter(Boolean).join('\n').slice(0, 8000) || 'Unknown backup failure';
    db.prepare(`UPDATE runs SET status='failed',completed_at=?,destination=?,error=?,
      claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=?`).run(completed, destination, detail, runId);
  } finally {
    clearInterval(heartbeat);
  }
}

function claimNextRun(): { id: string } | undefined {
  return db.transaction(() => {
    const row = db.prepare("SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (!row) return undefined;
    const now = new Date().toISOString();
    const claimed = db.prepare(`UPDATE runs SET status='running',claimed_by=?,heartbeat_at=?,lease_expires_at=?
      WHERE id=? AND status='queued'`).run(workerId, now, leaseExpiry(), row.id);
    return claimed.changes ? row : undefined;
  })();
}

export function recoverExpiredRuns(): number {
  const now = new Date().toISOString();
  return db.prepare(`UPDATE runs SET status='queued',claimed_by=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
    started_at=NULL,error=COALESCE(error,'Recovered after an interrupted worker')
    WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(now).changes;
}

async function pump() {
  while (active < config.workerConcurrency) {
    const row = claimNextRun();
    if (!row) break;
    active++;
    void executeRun(row.id).finally(() => { active--; queueMicrotask(pump); });
  }
}

export function startWorker() {
  if (timer) return;
  recoverExpiredRuns();
  workerStarted = true;
  timer = setInterval(pump, 1500);
  timer.unref();
  void pump();
}

export async function stopWorker(graceMs = 25_000) {
  workerStarted = false;
  if (timer) clearInterval(timer);
  timer = undefined;
  const deadline = Date.now() + graceMs;
  while (active > 0 && Date.now() < deadline) await wait(250);
}
