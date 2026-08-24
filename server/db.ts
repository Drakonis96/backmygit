import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { DEFAULT_SETTINGS, type AppSettings, type Retention, type Schedule } from './types.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'backmygit.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', stars INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public', default_branch TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT NOT NULL, retention_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner, name)
);
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, configured INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT, retention_json TEXT,
  next_run_at TEXT, last_run_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(repository_id, name)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','success','failed')),
  origin TEXT NOT NULL CHECK(origin IN ('manual','automatic')),
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, completed_at TEXT, commit_sha TEXT, size_bytes INTEGER,
  destination TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_branch
  ON runs(branch_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE, commit_sha TEXT NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'success',
  discovered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS backups_completed_idx ON backups(completed_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
  disabled_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(idle_expires_at,absolute_expires_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_address TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
`);

const existing = db.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string } | undefined;
if (!existing) {
  db.prepare('INSERT INTO settings(id,json,updated_at) VALUES(1,?,?)').run(JSON.stringify(DEFAULT_SETTINGS), new Date().toISOString());
}
db.prepare("UPDATE runs SET status='failed', completed_at=?, error=COALESCE(error, 'Application restarted during backup') WHERE status='running'")
  .run(new Date().toISOString());

export function getSettings(): AppSettings {
  const row = db.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string };
  try {
    const stored = JSON.parse(row.json) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      defaultSchedule: {
        ...DEFAULT_SETTINGS.defaultSchedule,
        ...(stored.defaultSchedule || {}),
      },
      defaultRetention: {
        ...DEFAULT_SETTINGS.defaultRetention,
        ...(stored.defaultRetention || {}),
      },
    };
  } catch (error) {
    console.error("Invalid settings JSON; using safe defaults", error);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function setSettings(settings: AppSettings): void {
  db.prepare('UPDATE settings SET json=?, updated_at=? WHERE id=1').run(JSON.stringify(settings), new Date().toISOString());
}

export function effectiveSchedule(repository: { schedule_json: string }, branch: { schedule_json: string | null }): Schedule {
  return JSON.parse(branch.schedule_json || repository.schedule_json);
}

export function effectiveRetention(repository: { retention_json: string }, branch: { retention_json: string | null }): Retention {
  return JSON.parse(branch.retention_json || repository.retention_json);
}

export function json<T>(value: T): string { return JSON.stringify(value); }
