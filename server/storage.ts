import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db } from './db.js';
import { branchDirectory, isWithin, repositoryDirectory } from './paths.js';
import type { BackupMetadata } from './types.js';

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
    if (entry.name !== '.tmp' && entry.isDirectory())
      backupsUsed += await directorySize(path.join(config.backupRoot, entry.name));
  }
  const byRepository = db.prepare(`SELECT r.id, r.owner, r.name, COALESCE(SUM(b.size_bytes),0) sizeBytes, COUNT(b.id) backups
    FROM repositories r LEFT JOIN backups b ON b.repository_id=r.id GROUP BY r.id ORDER BY sizeBytes DESC`).all();
  const byBranch = db.prepare(`SELECT br.id, r.owner, r.name repository, br.name branch, COALESCE(SUM(b.size_bytes),0) sizeBytes, COUNT(b.id) backups
    FROM branches br JOIN repositories r ON r.id=br.repository_id LEFT JOIN backups b ON b.branch_id=br.id GROUP BY br.id ORDER BY sizeBytes DESC`).all();
  return { root: config.backupRoot, hostPath: config.backupHostPath, capacity, used: capacity - free, free, backupsUsed, lowSpace: free < config.minFreeBytes, minimumFree: config.minFreeBytes, byRepository, byBranch };
}

async function removeIfEmpty(directory: string) {
  if (!isWithin(config.backupRoot, directory)) return;
  try { if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory); } catch { /* not empty or absent */ }
}

export async function deleteBackupRecord(id: number): Promise<void> {
  const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(id) as any;
  if (!backup) throw Object.assign(new Error('Backup not found'), { status: 404 });
  if (!isWithin(config.backupRoot, backup.path)) throw new Error('Refusing to delete a path outside the backup root');
  await fs.rm(backup.path, { recursive: true, force: true });
  db.prepare('DELETE FROM backups WHERE id=?').run(id);
  const branchDir = path.dirname(backup.path);
  await removeIfEmpty(branchDir);
  await removeIfEmpty(path.dirname(branchDir));
}

export async function reconcileFilesystem(): Promise<{ discovered: number }> {
  await fs.mkdir(path.join(config.backupRoot, '.tmp'), { recursive: true });
  const known = db.prepare("SELECT id,path FROM backups WHERE status='success'").all() as Array<{ id: number; path: string }>;
  const forget = db.prepare('DELETE FROM backups WHERE id=?');
  for (const backup of known) {
    try { await fs.access(backup.path); } catch { forget.run(backup.id); }
  }
  let discovered = 0;
  let repoDirs: import('node:fs').Dirent[];
  try { repoDirs = await fs.readdir(config.backupRoot, { withFileTypes: true }); } catch { return { discovered }; }
  for (const repoEntry of repoDirs.filter(x => x.name !== '.tmp' && x.isDirectory())) {
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
        if ((db.prepare('SELECT 1 FROM backups WHERE path=?').get(backupPath))) continue;
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
          const result = db.prepare(`INSERT OR IGNORE INTO backups(repository_id,branch_id,path,commit_sha,started_at,completed_at,size_bytes,duration_ms,origin,status,discovered)
            VALUES(?,?,?,?,?,?,?,?,?,'success',1)`).run(repo.id, branch.id, backupPath, metadata.commitSha, metadata.startedAt, metadata.completedAt,
              await directorySize(backupPath), completedAt.getTime()-startedAt.getTime(), metadata.origin);
          discovered += result.changes;
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
