import path from 'node:path';
import { DateTime } from 'luxon';
import { db, effectiveRetention } from './db.js';
import { deleteBackupRecord } from './storage.js';

export async function applyRetention(branchId: number): Promise<number> {
  const context = db.prepare(`SELECT br.*, r.retention_json repository_retention FROM branches br JOIN repositories r ON r.id=br.repository_id WHERE br.id=?`).get(branchId) as any;
  if (!context) return 0;
  const retention = effectiveRetention({ retention_json: context.repository_retention }, context);
  if (retention.mode === 'forever') return 0;
  const backups = db.prepare("SELECT * FROM backups WHERE branch_id=? AND status='success' ORDER BY completed_at DESC").all(branchId) as any[];
  if (backups.length <= 1) return 0;
  const protectedCount = Math.max(1, retention.minimumToKeep || 0);
  let cutoff: DateTime | null = null;
  if (retention.mode === 'age' || retention.mode === 'combined') {
    const amount = Math.max(1, retention.ageValue || 1);
    const unit = retention.ageUnit || 'days';
    cutoff = DateTime.utc().minus({ [unit]: amount });
  }
  const deletions = backups.filter((backup, index) => {
    if (index < protectedCount) return false;
    const tooOld = cutoff ? DateTime.fromISO(backup.completed_at) < cutoff : false;
    const beyondLatest = (retention.mode === 'latest' || retention.mode === 'combined') && index >= Math.max(1, retention.keepLatest || 1);
    return tooOld || beyondLatest;
  });
  let removed = 0;
  for (const backup of deletions) {
    // Path validation and empty-parent cleanup are centralized here.
    if (path.basename(backup.path).startsWith('.')) continue;
    await deleteBackupRecord(backup.id);
    removed++;
  }
  return removed;
}

export async function applyAllRetention(): Promise<number> {
  const branches = db.prepare('SELECT id FROM branches').all() as Array<{ id: number }>;
  let total = 0;
  for (const branch of branches) total += await applyRetention(branch.id);
  return total;
}
