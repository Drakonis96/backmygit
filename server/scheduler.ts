import { db, effectiveSchedule } from './db.js';
import { nextScheduledAfterAnchor, nextScheduledAt } from './schedule.js';
import { enqueueBackup } from './worker.js';

let timer: NodeJS.Timeout | undefined;

export function refreshNextRuns(repositoryId?: number, preserveExisting = false) {
  const rows = db.prepare(`SELECT br.*, r.enabled repository_enabled, r.schedule_json repository_schedule
    FROM branches br JOIN repositories r ON r.id=br.repository_id ${repositoryId ? 'WHERE r.id=?' : ''}`).all(...(repositoryId ? [repositoryId] : [])) as any[];
  const update = db.prepare('UPDATE branches SET next_run_at=? WHERE id=?');
  for (const row of rows) {
    if (preserveExisting && row.next_run_at) continue;
    const schedule = effectiveSchedule({ schedule_json: row.repository_schedule }, row);
    const next = row.enabled && row.configured && row.repository_enabled ? nextScheduledAt(schedule) : null;
    update.run(next?.toISOString() || null, row.id);
  }
}

function tick() {
  const now = new Date();
  const due = db.prepare(`SELECT br.*, r.schedule_json repository_schedule FROM branches br JOIN repositories r ON r.id=br.repository_id
    WHERE br.enabled=1 AND br.configured=1 AND r.enabled=1 AND br.next_run_at IS NOT NULL AND br.next_run_at <= ?`).all(now.toISOString()) as any[];
  for (const branch of due) {
    const schedule = effectiveSchedule({ schedule_json: branch.repository_schedule }, branch);
    const next = nextScheduledAfterAnchor(schedule, new Date(branch.next_run_at), now);
    db.prepare('UPDATE branches SET next_run_at=? WHERE id=?').run(next?.toISOString() || null, branch.id);
    enqueueBackup(branch.id, 'automatic');
  }
}

export function startScheduler() {
  // Preserve interval anchors and already-calculated due times across restarts.
  refreshNextRuns(undefined, true);
  tick();
  timer = setInterval(tick, 30_000);
  timer.unref();
}

export function stopScheduler() { if (timer) clearInterval(timer); }
