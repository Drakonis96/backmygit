import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db } from './db.js';
import { branchDirectory, isWithin, repositoryDirectory } from './paths.js';
import type { BackupMetadata } from './types.js';
import { enqueueSnapshotRemoteDeletions } from './transfer-queue.js';

const exec = promisify(execFile);

export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) { try { total += (await fs.stat(full)).size; } catch { /* file disappeared */ } }
    }
  }
  return total;
}

export async function storageStats() {
  await fs.mkdir(config.backupRoot, { recursive: true });
  const stat = await fs.statfs(config.backupRoot);
  const capacity = stat.blocks * stat.bsize;
  const free = stat.bavail * stat.bsize;
  let backupsUsed = 0;
  for (const entry of await fs.readdir(config.backupRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('.') && entry.isDirectory())
      backupsUsed += await directorySize(path.join(config.backupRoot, entry.name));
  }
  const byRepository = db.prepare(`SELECT r.id, r.owner, r.name, COALESCE(SUM(lr.size_bytes),0) sizeBytes, COUNT(lr.id) backups
    FROM repositories r LEFT JOIN snapshots s ON s.repository_id=r.id
    LEFT JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified'
    GROUP BY r.id ORDER BY sizeBytes DESC`).all();
  const byBranch = db.prepare(`SELECT br.id, r.owner, r.name repository, br.name branch, COALESCE(SUM(lr.size_bytes),0) sizeBytes, COUNT(lr.id) backups
    FROM branches br JOIN repositories r ON r.id=br.repository_id LEFT JOIN snapshots s ON s.branch_id=br.id
    LEFT JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified'
    GROUP BY br.id ORDER BY sizeBytes DESC`).all();
  return { root: config.backupRoot, hostPath: config.backupHostPath, capacity, used: capacity - free, free, backupsUsed, lowSpace: free < config.minFreeBytes, minimumFree: config.minFreeBytes, byRepository, byBranch };
}

async function removeIfEmpty(directory: string) {
  if (!isWithin(config.backupRoot, directory)) return;
  try { if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory); } catch { /* not empty or absent */ }
}

export async function deleteBackupRecord(id: number, deleteRemote = false): Promise<void> {
  const backup = db.prepare(`SELECT s.id,s.branch_id,s.remote_delete_requested,lr.id replica_id,lr.location path FROM snapshots s
    JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.id=?`).get(id) as any;
  if (!backup) throw Object.assign(new Error('Backup not found'), { status: 404 });
  if (!isWithin(config.backupRoot, backup.path)) throw new Error('Refusing to delete a path outside the backup root');
  const requestedAt = new Date().toISOString();
  db.prepare(`UPDATE snapshots SET deletion_requested_at=COALESCE(deletion_requested_at,?),
    remote_delete_requested=CASE WHEN ?=1 THEN 1 ELSE remote_delete_requested END WHERE id=?`)
    .run(requestedAt, deleteRemote ? 1 : 0, backup.id);
  await fs.rm(backup.path, { recursive: true, force: true });
  db.prepare("UPDATE backup_replicas SET status='deleted',deleted_at=?,updated_at=? WHERE id=?")
    .run(requestedAt, requestedAt, backup.replica_id);
  const remoteRequested = deleteRemote || Boolean(backup.remote_delete_requested);
  if (remoteRequested) enqueueSnapshotRemoteDeletions(backup.id);
  const branchDir = path.dirname(backup.path);
  await removeIfEmpty(branchDir);
  await removeIfEmpty(path.dirname(branchDir));
}

export async function replayPendingSnapshotDeletions(): Promise<number> {
  const rows = db.prepare(`SELECT s.id,s.remote_delete_requested,lr.id replica_id,lr.location path,lr.status
    FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local'
    WHERE s.deletion_requested_at IS NOT NULL`).all() as Array<{
      id: number; remote_delete_requested: number; replica_id: string; path: string; status: string;
    }>;
  let replayed = 0;
  for (const row of rows) {
    if (row.status !== 'deleted') {
      if (!isWithin(config.backupRoot, row.path)) throw new Error('Refusing to replay a deletion outside the backup root');
      await fs.rm(row.path, { recursive: true, force: true });
      const now = new Date().toISOString();
      db.prepare("UPDATE backup_replicas SET status='deleted',deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE id=?")
        .run(now, now, row.replica_id);
      replayed++;
    }
    if (row.remote_delete_requested) enqueueSnapshotRemoteDeletions(row.id);
  }
  return replayed;
}

export async function reconcileFilesystem(): Promise<{ discovered: number }> {
  await fs.mkdir(path.join(config.backupRoot, '.tmp'), { recursive: true });
  await replayPendingSnapshotDeletions();
  const known = db.prepare(`SELECT lr.id,lr.location path FROM backup_replicas lr
    WHERE lr.target_id='local' AND lr.status='verified'`).all() as Array<{ id: string; path: string }>;
  const forget = db.prepare("UPDATE backup_replicas SET status='deleted',deleted_at=?,updated_at=? WHERE id=?");
  for (const backup of known) {
    try { await fs.access(backup.path); } catch {
      const now = new Date().toISOString();
      forget.run(now, now, backup.id);
    }
  }
  let discovered = 0;
  let repoDirs: import('node:fs').Dirent[];
  try { repoDirs = await fs.readdir(config.backupRoot, { withFileTypes: true }); } catch { return { discovered }; }
  for (const repoEntry of repoDirs.filter(x => !x.name.startsWith('.') && x.isDirectory())) {
    const repoDir = repoEntry.name;
    const repoPath = path.join(config.backupRoot, repoDir);
    let branchDirs: import('node:fs').Dirent[]; try { branchDirs = await fs.readdir(repoPath, { withFileTypes: true }); } catch { continue; }
    for (const branchEntry of branchDirs.filter(entry => entry.isDirectory())) {
      const branchDir = branchEntry.name;
      const branchPath = path.join(repoPath, branchDir);
      let backupDirs: import('node:fs').Dirent[]; try { backupDirs = await fs.readdir(branchPath, { withFileTypes: true }); } catch { continue; }
      for (const backupEntry of backupDirs.filter(entry => entry.isDirectory())) {
        const backupDir = backupEntry.name;
        if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(backupDir)) continue;
        const backupPath = path.join(branchPath, backupDir);
        if ((db.prepare("SELECT 1 FROM backup_replicas WHERE target_id='local' AND location=? AND status='verified'").get(backupPath))) continue;
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(backupPath, 'backup-metadata.json'), 'utf8')) as BackupMetadata;
          if (
            metadata.schemaVersion !== 1 ||
            metadata.status !== 'success' ||
            !['manual', 'automatic'].includes(metadata.origin) ||
            !/^[0-9a-f]{40,64}$/.test(metadata.commitSha) ||
            !metadata.repository?.owner ||
            !metadata.repository?.name ||
            !metadata.branch ||
            repoDir !== repositoryDirectory(metadata.repository.owner, metadata.repository.name) ||
            branchDir !== branchDirectory(metadata.branch)
          ) continue;
          const startedAt = new Date(metadata.startedAt);
          const completedAt = new Date(metadata.completedAt);
          if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(completedAt.getTime()) || completedAt < startedAt) continue;
          const rootReal = await fs.realpath(config.backupRoot);
          const backupReal = await fs.realpath(backupPath);
          if (!isWithin(rootReal, backupReal)) continue;
          if (!(await fs.lstat(path.join(backupPath, '.git'))).isDirectory()) continue;
          const { stdout } = await exec('git', ['-C', backupPath, 'rev-parse', 'HEAD'], { timeout: 30_000 });
          if (stdout.trim() !== metadata.commitSha) continue;
          const repo = db.prepare('SELECT id FROM repositories WHERE owner=? AND name=?').get(metadata.repository.owner, metadata.repository.name) as any;
          if (!repo) continue;
          const branch = db.prepare('SELECT id FROM branches WHERE repository_id=? AND name=?').get(repo.id, metadata.branch) as any;
          if (!branch) continue;
          const sizeBytes = await directorySize(backupPath);
          const restorable = db.prepare(`SELECT lr.id FROM backup_replicas lr JOIN snapshots s ON s.id=lr.snapshot_id
            WHERE lr.target_id='local' AND lr.location=? AND lr.status='deleted'
              AND s.repository_id=? AND s.branch_id=? AND s.commit_sha=? AND s.completed_at=?
            ORDER BY lr.deleted_at DESC LIMIT 1`).get(
              backupPath, repo.id, branch.id, metadata.commitSha, metadata.completedAt,
            ) as { id: string } | undefined;
          if (restorable) {
            db.prepare(`UPDATE backup_replicas SET status='verified',size_bytes=?,sha256=?,verified_at=?,
              last_error=NULL,deleted_at=NULL,updated_at=? WHERE id=?`).run(
                sizeBytes, metadata.commitSha, metadata.completedAt, new Date().toISOString(), restorable.id,
              );
            discovered++;
            continue;
          }
          const inserted = db.transaction(() => {
            const snapshot = db.prepare(`INSERT INTO snapshots(repository_id,branch_id,commit_sha,started_at,completed_at,duration_ms,origin,status,metadata_json,created_at)
              VALUES(?,?,?,?,?,?,?,'success',?,?) RETURNING id`).get(
                repo.id, branch.id, metadata.commitSha, metadata.startedAt, metadata.completedAt,
                completedAt.getTime()-startedAt.getTime(), metadata.origin, JSON.stringify(metadata), metadata.completedAt,
              ) as { id: number };
            db.prepare(`INSERT INTO backup_replicas(id,snapshot_id,target_id,status,location,size_bytes,sha256,required,verified_at,created_at,updated_at)
              VALUES(?,?,'local','verified',?,?,?,?,?,?,?)`).run(
                randomUUID(), snapshot.id, backupPath, sizeBytes, metadata.commitSha, 1,
                metadata.completedAt, metadata.completedAt, metadata.completedAt,
              );
            return 1;
          })();
          discovered += inserted;
        } catch { /* only import complete, understandable backups */ }
      }
    }
  }
  return { discovered };
}

export async function resolveRealBackupPath(
  backupRoot: string,
  candidate: string,
  allowRoot = false,
): Promise<string> {
  const rootReal = await fs.realpath(backupRoot);
  if ((await fs.lstat(candidate)).isSymbolicLink())
    throw Object.assign(new Error('Symbolic links cannot be opened as backup paths'), { status: 400 });
  const candidateReal = await fs.realpath(candidate);
  if (
    candidateReal !== rootReal &&
    !isWithin(rootReal, candidateReal)
  )
    throw Object.assign(new Error('Invalid backup path'), { status: 400 });
  if (!allowRoot && candidateReal === rootReal)
    throw Object.assign(new Error('Invalid backup path'), { status: 400 });
  return candidateReal;
}

export function expectedPath(owner: string, repo: string, branch: string) {
  return path.join(config.backupRoot, repositoryDirectory(owner, repo), branchDirectory(branch));
}
