import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { isWithin } from './paths.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function cleanupInterruptedArtifacts(): Promise<number> {
  await fs.mkdir(config.artifactRoot, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const entry of await fs.readdir(config.artifactRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.tar\.zst\.[0-9a-f-]+\.tmp$/i.test(entry.name)) continue;
    await fs.rm(path.join(config.artifactRoot, entry.name), { force: true });
    removed++;
  }
  db.prepare("UPDATE artifacts SET status='failed',error='Recovered after interrupted artifact creation' WHERE status='creating'").run();
  return removed;
}

export interface ReadyArtifact {
  id: string;
  snapshot_id: number;
  path: string;
  size_bytes: number;
  sha256: string;
  format: 'tar.zst';
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest('hex');
}

async function pack(source: string, output: string): Promise<void> {
  const temporary = `${output}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const tar = spawn('tar', ['-cf', '-', '-C', source, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const zstd = spawn('zstd', ['-q', '-T0', '-3', '-o', temporary], { stdio: ['pipe', 'ignore', 'pipe'] });
  tar.stdout.pipe(zstd.stdin);
  let errors = '';
  tar.stderr.on('data', chunk => { if (errors.length < 8000) errors += chunk; });
  zstd.stderr.on('data', chunk => { if (errors.length < 8000) errors += chunk; });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    tar.kill('SIGKILL');
    zstd.kill('SIGKILL');
  }, config.rcloneTimeoutMs);
  try {
    const [tarCode, zstdCode] = await Promise.all([
      new Promise<number | null>((resolve, reject) => { tar.once('error', reject); tar.once('close', resolve); }),
      new Promise<number | null>((resolve, reject) => { zstd.once('error', reject); zstd.once('close', resolve); }),
    ]);
    if (timedOut || tarCode !== 0 || zstdCode !== 0)
      throw new Error(timedOut ? 'Artifact creation timed out' : errors.trim() || 'Artifact creation failed');
    await fs.rename(temporary, output);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function artifactRow(snapshotId: number): ReadyArtifact | undefined {
  return db.prepare("SELECT * FROM artifacts WHERE snapshot_id=? AND format='tar.zst' AND status='ready'").get(snapshotId) as ReadyArtifact | undefined;
}

export async function ensureArtifact(snapshotId: number, source: string): Promise<ReadyArtifact> {
  if (!isWithin(config.backupRoot, source)) throw new Error('Artifact source is outside the backup root');
  const finalPath = path.join(config.artifactRoot, `${snapshotId}.tar.zst`);
  if (!isWithin(config.backupRoot, finalPath) && config.artifactRoot === path.join(config.backupRoot, '.artifacts'))
    throw new Error('Invalid artifact path');
  const deadline = Date.now() + config.rcloneTimeoutMs;
  while (Date.now() < deadline) {
    const ready = artifactRow(snapshotId);
    if (ready) {
      try {
        const stat = await fs.stat(ready.path);
        if (stat.isFile() && stat.size === ready.size_bytes) return ready;
      } catch { /* recreate a missing artifact */ }
      db.prepare("UPDATE artifacts SET status='failed',error='Artifact file is missing' WHERE id=? AND status='ready'").run(ready.id);
    }
    const claim = db.transaction(() => {
      const row = db.prepare("SELECT * FROM artifacts WHERE snapshot_id=? AND format='tar.zst'").get(snapshotId) as any;
      const now = new Date();
      if (row?.status === 'creating' && now.getTime() - new Date(row.created_at).getTime() < 15 * 60_000)
        return { creator: false, id: row.id as string };
      if (row) {
        db.prepare("UPDATE artifacts SET status='creating',path=?,error=NULL,created_at=?,completed_at=NULL,deleted_at=NULL WHERE id=?")
          .run(finalPath, now.toISOString(), row.id);
        return { creator: true, id: row.id as string };
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO artifacts(id,snapshot_id,path,format,status,manifest_json,created_at)
        VALUES(?,?,?,'tar.zst','creating','{}',?)`).run(id, snapshotId, finalPath, now.toISOString());
      return { creator: true, id };
    })();
    if (!claim.creator) { await wait(500); continue; }
    try {
      await pack(source, finalPath);
      const stat = await fs.stat(finalPath);
      const sha256 = await sha256File(finalPath);
      const completed = new Date().toISOString();
      const manifest = { schemaVersion: 1, snapshotId, format: 'tar.zst', sizeBytes: stat.size, sha256 };
      db.prepare(`UPDATE artifacts SET status='ready',size_bytes=?,sha256=?,manifest_json=?,error=NULL,completed_at=? WHERE id=?`)
        .run(stat.size, sha256, JSON.stringify(manifest), completed, claim.id);
      return { id: claim.id, snapshot_id: snapshotId, path: finalPath, size_bytes: stat.size, sha256, format: 'tar.zst' };
    } catch (error: any) {
      db.prepare("UPDATE artifacts SET status='failed',error=? WHERE id=?").run(String(error?.message || error).slice(0, 8000), claim.id);
      throw error;
    }
  }
  throw new Error('Timed out waiting for artifact creation');
}

export async function removeArtifactIfIdle(snapshotId: number): Promise<void> {
  const pending = db.prepare(`SELECT 1 FROM backup_replicas WHERE snapshot_id=? AND target_id!='local'
    AND status IN ('queued','packing','uploading','verifying','retry_wait') LIMIT 1`).get(snapshotId);
  if (pending) return;
  const artifact = db.prepare("SELECT * FROM artifacts WHERE snapshot_id=? AND status='ready'").get(snapshotId) as any;
  if (!artifact) return;
  await fs.rm(artifact.path, { force: true });
  db.prepare("UPDATE artifacts SET status='deleted',deleted_at=? WHERE id=?").run(new Date().toISOString(), artifact.id);
}
