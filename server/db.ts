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
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);

function migrate(version: number, name: string, migration: () => void): void {
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) return;
    migration();
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
      .run(version, name, new Date().toISOString());
  }).immediate();
}

migrate(1, 'multi-location snapshots', () => {
  db.exec(`
    CREATE TABLE cloud_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_name TEXT NOT NULL UNIQUE,
      auth_type TEXT NOT NULL CHECK(auth_type IN ('external','managed_oauth','managed_credentials')),
      status TEXT NOT NULL CHECK(status IN ('pending','connected','reauthorization_required','disabled','error')),
      managed INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_tested_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE storage_targets (
      id TEXT PRIMARY KEY,
      connection_id TEXT REFERENCES cloud_connections(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN ('local','rclone')),
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      encryption_mode TEXT NOT NULL CHECK(encryption_mode IN ('none','crypt')),
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((kind='local' AND connection_id IS NULL) OR (kind='rclone' AND connection_id IS NOT NULL))
    );
    CREATE TABLE target_assignments (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES storage_targets(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('global','repository','branch')),
      scope_key TEXT NOT NULL,
      repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
      required INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      retention_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(target_id,scope_type,scope_key),
      CHECK(
        (scope_type='global' AND scope_key='global' AND repository_id IS NULL AND branch_id IS NULL) OR
        (scope_type='repository' AND repository_id IS NOT NULL AND branch_id IS NULL) OR
        (scope_type='branch' AND branch_id IS NOT NULL)
      )
    );
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      commit_sha TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('manual','automatic')),
      status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','invalid')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX snapshots_completed_idx ON snapshots(completed_at DESC);
    CREATE INDEX snapshots_branch_idx ON snapshots(branch_id,completed_at DESC);
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      format TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','creating','ready','failed','deleted')),
      size_bytes INTEGER,
      sha256 TEXT,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX artifacts_snapshot_idx ON artifacts(snapshot_id);
    CREATE TABLE backup_replicas (
      id TEXT PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES storage_targets(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('queued','packing','uploading','verifying','verified','retry_wait','failed','deleting','deleted')),
      location TEXT NOT NULL,
      size_bytes INTEGER,
      sha256 TEXT,
      remote_object_id TEXT,
      required INTEGER NOT NULL DEFAULT 1,
      verified_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(snapshot_id,target_id)
    );
    CREATE INDEX replicas_status_idx ON backup_replicas(status);
    CREATE INDEX replicas_target_idx ON backup_replicas(target_id,status);
    CREATE UNIQUE INDEX active_replica_location_idx ON backup_replicas(target_id,location)
      WHERE status != 'deleted';
    CREATE TABLE transfer_jobs (
      id TEXT PRIMARY KEY,
      replica_id TEXT NOT NULL REFERENCES backup_replicas(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('upload','verify','download','delete')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','retry_wait','success','failed','cancelled')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      bytes_total INTEGER,
      bytes_transferred INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      error_code TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_active_transfer_per_replica_operation
      ON transfer_jobs(replica_id,operation) WHERE status IN ('queued','running','retry_wait');
    CREATE INDEX transfer_jobs_queue_idx ON transfer_jobs(status,next_attempt_at,priority DESC,created_at);
    CREATE TABLE transfer_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT CHECK(outcome IN ('success','retry','failed','cancelled')),
      bytes_transferred INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error TEXT
    );
    CREATE INDEX transfer_attempts_job_idx ON transfer_attempts(job_id,attempt);
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO storage_targets(id,connection_id,kind,name,root_path,encryption_mode,enabled,config_json,created_at,updated_at)
    VALUES('local',NULL,'local','Local filesystem',?,'none',1,'{}',?,?)`).run(config.backupRoot, now, now);
  db.exec(`
    INSERT INTO snapshots(id,repository_id,branch_id,run_id,commit_sha,started_at,completed_at,duration_ms,origin,status,metadata_json,created_at)
      SELECT id,repository_id,branch_id,run_id,commit_sha,started_at,completed_at,duration_ms,origin,'success','{}',completed_at FROM backups;
    INSERT INTO backup_replicas(id,snapshot_id,target_id,status,location,size_bytes,sha256,required,verified_at,created_at,updated_at)
      SELECT 'local-' || id,id,'local','verified',path,size_bytes,commit_sha,1,completed_at,completed_at,completed_at FROM backups;
  `);
});

migrate(2, 'worker leases and encrypted secrets', () => {
  db.exec(`
    ALTER TABLE runs ADD COLUMN claimed_by TEXT;
    ALTER TABLE runs ADD COLUMN lease_expires_at TEXT;
    ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;
    ALTER TABLE transfer_jobs ADD COLUMN claimed_by TEXT;
    ALTER TABLE transfer_jobs ADD COLUMN lease_expires_at TEXT;
    ALTER TABLE transfer_jobs ADD COLUMN heartbeat_at TEXT;
    CREATE TABLE encrypted_secrets (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('connection','oauth_state','recovery')),
      owner_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_type,owner_id,purpose)
    );
    CREATE INDEX encrypted_secrets_owner_idx ON encrypted_secrets(owner_type,owner_id);
  `);
});

// The local target is deployment configuration, not historical state. Keep it in
// sync when an existing database is mounted at a different backup path.
db.prepare("UPDATE storage_targets SET root_path=?,updated_at=? WHERE id='local'")
  .run(config.backupRoot, new Date().toISOString());

const existing = db.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string } | undefined;
if (!existing) {
  db.prepare('INSERT INTO settings(id,json,updated_at) VALUES(1,?,?)').run(JSON.stringify(DEFAULT_SETTINGS), new Date().toISOString());
}
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
