import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backmygit-migration-'));
const dataDir = path.join(root, 'data');
const firstBackupRoot = path.join(root, 'backups-v1');
const secondBackupRoot = path.join(root, 'backups-v2');
fs.mkdirSync(dataDir);
fs.mkdirSync(firstBackupRoot);
fs.mkdirSync(secondBackupRoot);

const databasePath = path.join(dataDir, 'backmygit.sqlite');
const legacy = new Database(databasePath);
legacy.pragma('foreign_keys = ON');
legacy.exec(`
  CREATE TABLE repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', stars INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'public',
    default_branch TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, schedule_json TEXT NOT NULL,
    retention_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner,name)
  );
  CREATE TABLE branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, configured INTEGER NOT NULL DEFAULT 1,
    schedule_json TEXT, retention_json TEXT, next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL,
    UNIQUE(repository_id,name)
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('queued','running','success','failed')),
    origin TEXT NOT NULL CHECK(origin IN ('manual','automatic')), attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT, completed_at TEXT, commit_sha TEXT, size_bytes INTEGER, destination TEXT,
    error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    path TEXT NOT NULL UNIQUE, commit_sha TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, duration_ms INTEGER NOT NULL, origin TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success', discovered INTEGER NOT NULL DEFAULT 0
  );
`);
const timestamp = '2026-08-24T10:00:00.000Z';
legacy.prepare(`INSERT INTO repositories(id,owner,name,url,default_branch,schedule_json,retention_json,created_at,updated_at)
  VALUES(1,'example','repo','https://github.com/example/repo.git','main','{}','{}',?,?)`).run(timestamp, timestamp);
legacy.prepare(`INSERT INTO branches(id,repository_id,name,created_at) VALUES(1,1,'main',?)`).run(timestamp);
legacy.prepare(`INSERT INTO runs(id,repository_id,branch_id,status,origin,attempts,started_at,completed_at,commit_sha,size_bytes,destination,created_at)
  VALUES('run-1',1,1,'success','manual',1,?,?,?,?,?,?)`).run(
    timestamp, timestamp, 'a'.repeat(40), 1234, path.join(firstBackupRoot, 'legacy'), timestamp,
  );
legacy.prepare(`INSERT INTO backups(id,repository_id,branch_id,run_id,path,commit_sha,started_at,completed_at,size_bytes,duration_ms,origin)
  VALUES(1,1,1,'run-1',?,?,?,?,1000,1234,'manual')`).run(
    path.join(firstBackupRoot, 'legacy'), 'a'.repeat(40), timestamp, timestamp,
  );
legacy.close();

const inspect = `
  import('./dist-server/db.js').then(({db}) => {
    const result = {
      migration: db.prepare('SELECT name FROM schema_migrations WHERE version=1').get(),
      leaseMigration: db.prepare('SELECT name FROM schema_migrations WHERE version=2').get(),
      targetSecretMigration: db.prepare('SELECT name FROM schema_migrations WHERE version=3').get(),
      transferProgressMigration: db.prepare('SELECT name FROM schema_migrations WHERE version=4').get(),
      oauthMigration: db.prepare('SELECT name FROM schema_migrations WHERE version=5').get(),
      fencingMigration: db.prepare('SELECT name FROM schema_migrations WHERE version=6').get(),
      legacy: db.prepare('SELECT COUNT(*) count FROM backups').get(),
      snapshots: db.prepare('SELECT COUNT(*) count FROM snapshots').get(),
      replica: db.prepare("SELECT snapshot_id,target_id,status,location,size_bytes FROM backup_replicas WHERE id='local-1'").get(),
      localTarget: db.prepare("SELECT root_path FROM storage_targets WHERE id='local'").get(),
      foreignKeys: db.pragma('foreign_key_check'),
      encryptedSecretsTable: db.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='encrypted_secrets'").get(),
      runColumns: db.prepare('PRAGMA table_info(runs)').all().map(column => column.name),
    };
    process.stdout.write(JSON.stringify(result));
    db.close();
  });
`;
const run = backupRoot => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', inspect], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: dataDir, BACKUP_ROOT: backupRoot },
  encoding: 'utf8',
}));

const inspectSecretAndLeases = `
  Promise.all([import('./dist-server/db.js'), import('./dist-server/secrets.js'), import('./dist-server/worker.js'), import('./dist-server/transfer-queue.js'), import('./dist-server/storage.js')]).then(async ([{db}, secrets, worker, transfers, storage]) => {
    await secrets.ensureMasterKey();
    await secrets.putSecret('connection', 'connection-1', 'rclone-config', { password: 'must-never-appear-in-sqlite' });
    const opened = await secrets.getSecret('connection', 'connection-1', 'rclone-config');
    const firstRevision = await secrets.getSecretWithRevision('connection', 'connection-1', 'rclone-config');
    await secrets.putSecret('connection', 'connection-1', 'rclone-config', { password: 'new-oauth-token' });
    const staleSecretWrite = await secrets.putSecretIfRevision('connection', 'connection-1', 'rclone-config', firstRevision.revision, { password: 'stale-token' });
    const currentSecret = await secrets.getSecret('connection', 'connection-1', 'rclone-config');
    const keyStat = await import('node:fs/promises').then(fs => fs.stat(process.env.BACKMYGIT_TEST_KEY_PATH));
    const now = new Date();
    db.prepare("INSERT INTO branches(id,repository_id,name,created_at) VALUES(2,1,'expired',?)").run(now.toISOString());
    db.prepare("INSERT INTO branches(id,repository_id,name,created_at) VALUES(3,1,'leased',?)").run(now.toISOString());
    const insert = db.prepare("INSERT INTO runs(id,repository_id,branch_id,status,origin,created_at,claimed_by,lease_expires_at) VALUES(?,1,?,'running','manual',?,'worker-test',?)");
    insert.run('expired-run', 2, now.toISOString(), new Date(now.getTime() - 1000).toISOString());
    insert.run('leased-run', 3, now.toISOString(), new Date(now.getTime() + 60000).toISOString());
    const recovered = worker.recoverExpiredRuns();
    const stamp = now.toISOString();
    db.prepare("INSERT INTO cloud_connections(id,name,provider,remote_name,auth_type,status,managed,created_at,updated_at) VALUES('retry-connection','Retry','external','retry_remote','external','connected',0,?,?)").run(stamp, stamp);
    db.prepare("INSERT INTO storage_targets(id,connection_id,kind,name,root_path,encryption_mode,created_at,updated_at) VALUES('retry-target','retry-connection','rclone','Retry target','BackMyGit','none',?,?)").run(stamp, stamp);
    db.prepare("INSERT INTO backup_replicas(id,snapshot_id,target_id,status,location,created_at,updated_at) VALUES('retry-replica',1,'retry-target','uploading','retry.tar.zst',?,?)").run(stamp, stamp);
    db.prepare("INSERT INTO transfer_jobs(id,replica_id,operation,status,attempts,bytes_transferred,created_at,updated_at,claimed_by) VALUES('retry-job','retry-replica','upload','running',1,0,?,?,'worker-a')").run(stamp, stamp);
    db.prepare("INSERT INTO transfer_attempts(job_id,attempt,started_at) VALUES('retry-job',1,?)").run(stamp);
    const retryable = transfers.failTransfer('retry-job', 'retry-replica', 'worker-a', 1, new Error('quota exceeded'));
    db.prepare("UPDATE transfer_jobs SET status='running',attempts=5,claimed_by='worker-b' WHERE id='retry-job'").run();
    db.prepare("INSERT INTO transfer_attempts(job_id,attempt,started_at) VALUES('retry-job',5,?)").run(stamp);
    db.prepare("UPDATE backup_replicas SET status='uploading' WHERE id='retry-replica'").run();
    const staleCompletion = transfers.completeTransfer('retry-job', 'retry-replica', 'worker-a', 1, { size_bytes: 5, sha256: 'b'.repeat(64) });
    const statusAfterStaleCompletion = db.prepare("SELECT status,claimed_by,attempts FROM transfer_jobs WHERE id='retry-job'").get();
    const terminal = transfers.failTransfer('retry-job', 'retry-replica', 'worker-b', 5, new Error('connection timed out'));
    const crashPath = (await import('node:path')).join(process.env.BACKUP_ROOT, 'crash-delete');
    await import('node:fs/promises').then(fs => fs.mkdir(crashPath, { recursive: true }));
    db.prepare("INSERT INTO snapshots(id,repository_id,branch_id,commit_sha,started_at,completed_at,duration_ms,origin,status,created_at,deletion_requested_at,remote_delete_requested) VALUES(2,1,1,?,?,?,1,'manual','success',?,?,1)").run('c'.repeat(40), stamp, stamp, stamp, stamp);
    db.prepare("INSERT INTO backup_replicas(id,snapshot_id,target_id,status,location,size_bytes,sha256,required,verified_at,created_at,updated_at) VALUES('crash-local',2,'local','verified',?,1,?,1,?,?,?)").run(crashPath, 'c'.repeat(40), stamp, stamp, stamp);
    db.prepare("INSERT INTO backup_replicas(id,snapshot_id,target_id,status,location,size_bytes,sha256,required,verified_at,created_at,updated_at) VALUES('crash-remote',2,'retry-target','verified','crash.tar.zst',1,?,1,?,?,?)").run('d'.repeat(64), stamp, stamp, stamp);
    const replayedDeletion = await storage.replayPendingSnapshotDeletions();
    const crashDeletion = db.prepare("SELECT lr.status local_status,rr.deletion_requested_at,(SELECT status FROM transfer_jobs WHERE replica_id='crash-remote' AND operation='delete') delete_status FROM backup_replicas lr JOIN backup_replicas rr ON rr.snapshot_id=lr.snapshot_id AND rr.id='crash-remote' WHERE lr.id='crash-local'").get();
    const ciphertext = db.prepare("SELECT ciphertext FROM encrypted_secrets WHERE owner_id='connection-1'").get().ciphertext;
    const states = db.prepare("SELECT id,status,claimed_by FROM runs WHERE id IN ('expired-run','leased-run') ORDER BY id").all();
    process.stdout.write(JSON.stringify({ opened, staleSecretWrite, currentSecret, ciphertext, keyMode: keyStat.mode & 511, recovered, states, retryable, staleCompletion, statusAfterStaleCompletion, terminal, replayedDeletion, crashDeletion }));
    db.close();
  });
`;
const securityEnvironment = {
  ...process.env,
  DATA_DIR: dataDir,
  BACKUP_ROOT: secondBackupRoot,
  BACKMYGIT_TEST_KEY_PATH: path.join(dataDir, 'master.key'),
};
delete securityEnvironment.MASTER_KEY_FILE;
const securityRun = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', inspectSecretAndLeases], {
  cwd: process.cwd(),
  env: securityEnvironment,
  encoding: 'utf8',
}));

try {
  const migrated = run(firstBackupRoot);
  if (migrated.migration?.name !== 'multi-location snapshots') throw new Error('migration was not recorded');
  if (migrated.leaseMigration?.name !== 'worker leases and encrypted secrets') throw new Error('lease migration was not recorded');
  if (migrated.targetSecretMigration?.name !== 'target-scoped secrets') throw new Error('target secret migration was not recorded');
  if (migrated.transferProgressMigration?.name !== 'transfer progress and artifact uniqueness') throw new Error('transfer progress migration was not recorded');
  if (migrated.oauthMigration?.name !== 'oauth flows and connection locks') throw new Error('OAuth migration was not recorded');
  if (migrated.fencingMigration?.name !== 'durable deletion intent and transfer fencing') throw new Error('transfer fencing migration was not recorded');
  if (migrated.legacy.count !== 1 || migrated.snapshots.count !== 1) throw new Error('legacy snapshot was not migrated exactly once');
  if (migrated.replica?.status !== 'verified' || migrated.replica?.target_id !== 'local' || migrated.replica?.size_bytes !== 1000)
    throw new Error('local replica migration is invalid');
  if (migrated.localTarget?.root_path !== firstBackupRoot) throw new Error('local target root is invalid');
  if (migrated.foreignKeys.length) throw new Error('foreign key violations after migration');
  if (!migrated.encryptedSecretsTable?.present || !['claimed_by', 'lease_expires_at', 'heartbeat_at'].every(name => migrated.runColumns.includes(name)))
    throw new Error('worker lease or encrypted secret schema is missing');

  const restarted = run(secondBackupRoot);
  if (restarted.snapshots.count !== 1 || restarted.legacy.count !== 1) throw new Error('migration is not idempotent');
  if (restarted.localTarget?.root_path !== secondBackupRoot) throw new Error('local target root was not refreshed');
  if (restarted.foreignKeys.length) throw new Error('foreign key violations after restart');
  const secured = securityRun();
  if (secured.opened?.password !== 'must-never-appear-in-sqlite' || secured.ciphertext.includes('must-never-appear-in-sqlite'))
    throw new Error('encrypted secret storage is invalid');
  if (secured.staleSecretWrite || secured.currentSecret?.password !== 'new-oauth-token')
    throw new Error('stale secret revisions can overwrite reauthorized credentials');
  if (secured.keyMode !== 0o600) throw new Error('master key permissions are not 0600');
  if (secured.recovered !== 1 || secured.states[0]?.id !== 'expired-run' || secured.states[0]?.status !== 'queued' || secured.states[0]?.claimed_by !== null)
    throw new Error('expired run lease was not recovered');
  if (secured.states[1]?.id !== 'leased-run' || secured.states[1]?.status !== 'running' || secured.states[1]?.claimed_by !== 'worker-test')
    throw new Error('active run lease was incorrectly recovered');
  if (secured.retryable?.terminal || secured.retryable?.code !== 'quota' || !secured.retryable?.nextAttemptAt)
    throw new Error('retryable transfer failure did not receive classified backoff');
  if (!secured.terminal?.terminal || secured.terminal?.code !== 'timeout' || secured.terminal?.nextAttemptAt)
    throw new Error('terminal transfer failure did not stop at the configured attempt limit');
  if (secured.staleCompletion?.accepted || secured.statusAfterStaleCompletion?.status !== 'running' || secured.statusAfterStaleCompletion?.claimed_by !== 'worker-b' || secured.statusAfterStaleCompletion?.attempts !== 5)
    throw new Error('a stale transfer worker can overwrite a newer claim');
  if (secured.replayedDeletion !== 1 || secured.crashDeletion?.local_status !== 'deleted' || !secured.crashDeletion?.deletion_requested_at || secured.crashDeletion?.delete_status !== 'queued')
    throw new Error('durable deletion intent was not replayed after an injected crash boundary');
  console.log('Migration test passed: legacy data preserved, migrated once, constraints valid, local root refreshed.');
  console.log('Worker security test passed: encrypted secrets, 0600 master key, and selective lease recovery.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
