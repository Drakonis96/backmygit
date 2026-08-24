import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

const exec = promisify(execFile);
const base = process.env.TEST_BASE_URL;
const backupRoot = process.env.TEST_BACKUP_ROOT;
const databasePath = process.env.TEST_DATABASE_PATH;
const remoteRoot = process.env.TEST_REMOTE_ROOT;
const rcloneDelayFile = process.env.TEST_RCLONE_DELAY_FILE;
if (!base || !backupRoot || !databasePath || !remoteRoot || !rcloneDelayFile)
  throw new Error(
    "TEST_BASE_URL, TEST_BACKUP_ROOT, TEST_DATABASE_PATH, TEST_REMOTE_ROOT and TEST_RCLONE_DELAY_FILE are required",
  );

const checks = [];
let sessionCookie = "";
let csrfToken = "";
const ok = (name, condition, detail = "") => {
  if (!condition)
    throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  checks.push(name);
  console.log(`✓ ${name}`);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, options = {}) {
  const response = await fetch(`${base}/api${url}`, {
    ...options,
    headers: {
      ...(!["GET", "HEAD", "OPTIONS"].includes(String(options.method || "GET").toUpperCase())
        ? { "Content-Type": "application/json" }
        : {}),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(!["GET", "HEAD", "OPTIONS"].includes(String(options.method || "GET").toUpperCase()) && csrfToken
        ? { "X-CSRF-Token": csrfToken }
        : {}),
      ...options.headers,
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";", 1)[0];
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  if (!response.ok)
    throw new Error(
      `${options.method || "GET"} ${url} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  return body;
}
const json = (url, method, body) =>
  request(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function waitForRun(id, expected, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await request("/history?page=1&pageSize=100");
    const run = history.items.find((item) => item.id === id);
    if (run?.status === expected) return run;
    if (run?.status === "failed" && expected !== "failed")
      throw new Error(run.error || "Backup failed");
    await delay(500);
  }
  throw new Error(`Run ${id} did not reach ${expected}`);
}

const health = await request("/health");
ok("health endpoint", health.status === "ok");
const setupStatus = await request("/auth/setup-status");
if (setupStatus.required) {
  const bootstrapToken = (await fs.readFile(path.join(path.dirname(databasePath), "bootstrap-token"), "utf8")).trim();
  const session = await json("/auth/setup", "POST", {
    token: bootstrapToken,
    username: "integration-admin",
    password: "integration-test-password-2026",
  });
  csrfToken = session.csrfToken;
  ok("secure initial administrator setup", session.user.role === "admin" && Boolean(sessionCookie));
} else {
  throw new Error("Integration test requires a fresh database without users");
}

const providers = await request('/cloud/providers');
ok(
  'cloud provider catalog',
  ['drive', 'dropbox', 'onedrive', 'mega', 's3', 'external'].every(provider => providers.items.some(item => item.id === provider)),
);
const oauthConfig = await request('/cloud/oauth/config');
ok('OAuth callback uses the configured public URL', oauthConfig.redirectUri === `${base}/api/cloud/oauth/callback`);
const oauth = await json('/cloud/oauth/start', 'POST', {
  name: 'Integration Drive OAuth',
  provider: 'drive',
  clientId: 'integration-oauth-client-id',
  clientSecret: 'integration-oauth-client-secret',
});
const authorization = new URL(oauth.authorizationUrl);
const oauthState = authorization.searchParams.get('state');
const oauthDatabase = new Database(databasePath, { readonly: true });
const oauthFlow = oauthDatabase.prepare('SELECT state_hash FROM oauth_flows WHERE connection_id=?').get(oauth.connection.id);
const oauthCiphertext = oauthDatabase.prepare("SELECT group_concat(ciphertext,'') ciphertext FROM encrypted_secrets WHERE owner_id IN (?,(SELECT id FROM oauth_flows WHERE connection_id=?))")
  .get(oauth.connection.id, oauth.connection.id).ciphertext;
oauthDatabase.close();
ok(
  'OAuth start uses PKCE and stores only encrypted secrets and hashed state',
  authorization.origin === 'https://accounts.google.com' &&
    authorization.searchParams.get('code_challenge_method') === 'S256' &&
    Boolean(authorization.searchParams.get('code_challenge')) && Boolean(oauthState) &&
    oauthFlow.state_hash !== oauthState && !oauthCiphertext.includes('integration-oauth-client-secret'),
);
const deniedCallback = await fetch(`${base}/api/cloud/oauth/callback?state=${encodeURIComponent(oauthState)}&error=access_denied`, {
  headers: { Cookie: sessionCookie }, redirect: 'manual',
});
const deniedSecretDatabase = new Database(databasePath, { readonly: true });
const deniedSecrets = deniedSecretDatabase.prepare("SELECT COUNT(*) count FROM encrypted_secrets WHERE owner_id=? AND purpose='oauth-client'").get(oauth.connection.id).count;
deniedSecretDatabase.close();
ok('OAuth denial is consumed once, cleans temporary client secrets, and redirects safely', deniedCallback.status === 303 && deniedCallback.headers.get('location') === `${base}/destinations?oauth=error` && deniedSecrets === 0);
const replayedCallback = await fetch(`${base}/api/cloud/oauth/callback?state=${encodeURIComponent(oauthState)}&error=access_denied`, {
  headers: { Cookie: sessionCookie }, redirect: 'manual',
});
ok('OAuth state replay is rejected', replayedCallback.status === 400);
const managedConnection = await json('/cloud/connections', 'POST', {
  name: 'Managed MEGA test',
  provider: 'mega',
  credentials: { username: 'integration@example.com', password: 'managed-secret-password' },
});
const connectionList = await request('/cloud/connections');
const secretDatabase = new Database(databasePath, { readonly: true });
const storedSecret = secretDatabase.prepare("SELECT ciphertext FROM encrypted_secrets WHERE owner_type='connection' AND owner_id=?").get(managedConnection.id);
secretDatabase.close();
ok(
  'managed cloud credentials remain encrypted',
  !JSON.stringify(managedConnection).includes('integration@example.com') &&
    !JSON.stringify(connectionList).includes('managed-secret-password') &&
    !storedSecret.ciphertext.includes('integration@example.com') &&
    !storedSecret.ciphertext.includes('managed-secret-password'),
);
const connection = await json('/cloud/connections', 'POST', {
  name: 'Integration rclone',
  provider: 'external',
  remoteName: 'integration_local',
});
ok('external rclone connection creation', connection.managed === false && !JSON.stringify(connection).includes('credentials'));
const testedConnection = await json(`/cloud/connections/${connection.id}/test`, 'POST');
ok('rclone connection test', testedConnection.status === 'connected');
const remoteFolders = await request(`/cloud/connections/${connection.id}/browse?path=BackMyGit`);
ok(
  'remote folder browser',
  remoteFolders.items.length === 1 && remoteFolders.items[0].path === 'BackMyGit/Projects' && remoteFolders.items[0].id === 'folder-1',
);
const traversalResponse = await fetch(`${base}/api/cloud/connections/${connection.id}/browse?path=${encodeURIComponent('../private')}`, {
  headers: { Cookie: sessionCookie },
});
ok('remote folder traversal is blocked', traversalResponse.status === 400);
const cloudTarget = await json('/cloud/targets', 'POST', {
  connectionId: connection.id,
  name: 'Integration destination',
  rootPath: remoteFolders.items[0].path,
  encryptionMode: 'none',
});
const assignments = await json('/cloud/assignments/global', 'PUT', { targetIds: [cloudTarget.id] });
const storedAssignments = await request('/cloud/assignments/global');
ok(
  'multiple destination assignment persistence',
  assignments.targetIds[0] === cloudTarget.id && storedAssignments.targetIds[0] === cloudTarget.id,
);

const exact = await request("/github/search?q=drakonis96%20nodus");
ok(
  "owner/repository discovery",
  exact.items.length === 1 &&
    exact.items[0].fullName.toLowerCase() === "drakonis96/nodus",
);

const locationCases = [
  ["Madrid", "Europe/Madrid"],
  ["Barcelona", "Europe/Madrid"],
  ["London", "Europe/London"],
  ["New York", "America/New_York"],
  ["Tokyo", "Asia/Tokyo"],
];
for (const [location, timezone] of locationCases) {
  const locations = await request(
    `/locations/timezones?q=${encodeURIComponent(location)}&language=en`,
  );
  ok(
    `location timezone lookup: ${location}`,
    locations.items.some((item) => item.timezone === timezone),
  );
}

const branches = await request("/github/repos/octocat/Hello-World/branches");
ok(
  "real branch discovery",
  branches.items.some((branch) => branch.name === "master"),
);

const defaults = await request("/settings");
const invalidTimezone = await fetch(`${base}/api/settings`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie, "X-CSRF-Token": csrfToken },
  body: JSON.stringify({
    ...defaults,
    timezone: "Definitely/Not_A_Timezone",
    defaultSchedule: {
      ...defaults.defaultSchedule,
      timezone: "Definitely/Not_A_Timezone",
    },
  }),
});
ok("invalid timezones are rejected", invalidTimezone.status === 400);
const schedule = {
  ...defaults.defaultSchedule,
  enabled: true,
  type: "daily",
  time: "03:00",
  timezone: "UTC",
};
const retention = {
  mode: "latest",
  ageValue: 30,
  ageUnit: "days",
  keepLatest: 1,
  minimumToKeep: 1,
};
const created = await json("/repositories", "POST", {
  repositories: [
    {
      owner: "octocat",
      name: "Hello-World",
      description: "Integration test",
      stars: 0,
      visibility: "public",
      defaultBranch: "master",
      branchNames: ["master"],
    },
  ],
  schedule,
  retention,
});
const repositoryId = created.items[0].id;
const detail = await request(`/repositories/${repositoryId}`);
const branchId = detail.branches.find((branch) => branch.name === "master").id;
ok(
  "repository and branch persistence",
  detail.owner === "octocat" && branchId > 0,
);

const firstRequest = await json("/backups/run", "POST", {
  branchIds: [branchId],
});
const duplicateRequest = await json("/backups/run", "POST", {
  branchIds: [branchId],
});
ok(
  "overlap prevention",
  firstRequest.items[0].queued === true &&
    duplicateRequest.items[0].queued === false,
);
const firstRun = await waitForRun(firstRequest.items[0].id, "success");
ok(
  "manual background backup",
  firstRun.origin === "manual" && /^[0-9a-f]{40}$/.test(firstRun.commit_sha),
);

const metadataPath = path.join(firstRun.destination, "backup-metadata.json");
const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
const gitDir = await fs.stat(path.join(firstRun.destination, ".git"));
const { stdout: gitSha } = await exec("git", [
  "-C",
  firstRun.destination,
  "rev-parse",
  "HEAD",
]);
ok(
  "usable Git repository contents",
  gitDir.isDirectory() && gitSha.trim() === firstRun.commit_sha,
);
ok(
  "self-describing metadata",
  metadata.branch === "master" &&
    metadata.commitSha === firstRun.commit_sha &&
    metadata.status === "success",
);

const initialBackups = await request(`/backups?repositoryId=${repositoryId}`);
const firstBackupId = initialBackups.items.find(
  (backup) => backup.run_id === firstRun.id,
)?.id;
ok("backup metadata persistence", Number.isInteger(firstBackupId));
let completedTransfer;
const transferDeadline = Date.now() + 45_000;
while (Date.now() < transferDeadline) {
  const transferList = await request('/cloud/transfers?limit=20');
  completedTransfer = transferList.items.find(item => item.snapshot_id === firstBackupId && item.target_id === cloudTarget.id);
  if (completedTransfer?.status === 'success') break;
  if (completedTransfer?.status === 'failed') throw new Error(completedTransfer.error);
  await delay(250);
}
ok(
  'cloud fan-out transfer with persisted progress',
  completedTransfer?.status === 'success' && completedTransfer.bytes_total > 0 &&
    completedTransfer.bytes_transferred === completedTransfer.bytes_total && completedTransfer.attempts === 1,
);
const remoteArtifactPath = path.join(remoteRoot, cloudTarget.rootPath, ...completedTransfer.location.split('/'));
const remoteArtifact = await fs.readFile(remoteArtifactPath);
const replicaDatabase = new Database(databasePath, { readonly: true });
const verifiedReplica = replicaDatabase.prepare('SELECT status,sha256,size_bytes FROM backup_replicas WHERE snapshot_id=? AND target_id=?').get(firstBackupId, cloudTarget.id);
replicaDatabase.close();
ok(
  'download-based remote SHA-256 verification',
  verifiedReplica.status === 'verified' && verifiedReplica.size_bytes === remoteArtifact.length &&
    verifiedReplica.sha256 === createHash('sha256').update(remoteArtifact).digest('hex'),
);
const idempotencyDatabase = new Database(databasePath);
idempotencyDatabase.prepare("UPDATE transfer_jobs SET status='queued',attempts=0,completed_at=NULL WHERE id=?").run(completedTransfer.id);
idempotencyDatabase.prepare("UPDATE backup_replicas SET status='queued',verified_at=NULL WHERE snapshot_id=? AND target_id=?").run(firstBackupId, cloudTarget.id);
idempotencyDatabase.close();
const idempotencyDeadline = Date.now() + 45_000;
while (Date.now() < idempotencyDeadline) {
  const transferList = await request('/cloud/transfers?limit=20');
  completedTransfer = transferList.items.find(item => item.id === completedTransfer.id);
  if (completedTransfer?.status === 'success') break;
  if (completedTransfer?.status === 'failed') throw new Error(completedTransfer.error);
  await delay(250);
}
ok('idempotent replay against an existing verified remote object', completedTransfer?.status === 'success' && completedTransfer.attempts === 1);
const contents = await request(`/backups/${firstBackupId}/contents`);
ok(
  "filesystem content browser",
  contents.items.some((item) => item.name === ".git") &&
    contents.items.some((item) => item.name === "backup-metadata.json"),
);
const outsideFile = path.join(path.dirname(backupRoot), "backmygit-outside-test.txt");
const symlinkName = "backmygit-outside-link";
await fs.writeFile(outsideFile, "must not be downloadable");
await fs.symlink(outsideFile, path.join(firstRun.destination, symlinkName));
const withSymlink = await request(`/backups/${firstBackupId}/contents`);
ok(
  "symlink is identified without being followed",
  withSymlink.items.some(
    (item) => item.name === symlinkName && item.type === "symlink",
  ),
);
const symlinkDownload = await fetch(
  `${base}/api/backups/${firstBackupId}/file?path=${encodeURIComponent(symlinkName)}`,
  { headers: { Cookie: sessionCookie } },
);
ok("symlink download is blocked", symlinkDownload.status === 400);
await fs.unlink(path.join(firstRun.destination, symlinkName));
await fs.unlink(outsideFile);
const zip = await request(`/backups/${firstBackupId}/download`);
ok(
  "ZIP export",
  Buffer.isBuffer(zip) && zip.subarray(0, 2).toString() === "PK",
);

await json(`/backups/${firstBackupId}`, 'DELETE');
const recoverable = await request('/cloud/recoverable');
ok('deleted local backup remains recoverable from a verified cloud replica', recoverable.items.some(item => item.id === firstBackupId && item.target_id === cloudTarget.id));
const restoreRequest = await json(`/cloud/recoverable/${firstBackupId}/restore`, 'POST', { targetId: cloudTarget.id });
let restoreTransfer;
const restoreDeadline = Date.now() + 45_000;
while (Date.now() < restoreDeadline) {
  const transferList = await request('/cloud/transfers?limit=50');
  restoreTransfer = transferList.items.find(item => item.id === restoreRequest.jobId);
  if (restoreTransfer?.status === 'success') break;
  if (restoreTransfer?.status === 'failed') throw new Error(restoreTransfer.error);
  await delay(250);
}
const restoredBackups = await request(`/backups?repositoryId=${repositoryId}`);
ok(
  'cloud restore verifies archive, metadata, and Git commit before publication',
  restoreTransfer?.status === 'success' && restoredBackups.items.some(item => item.id === firstBackupId) &&
    (await exec('git', ['-C', firstRun.destination, 'rev-parse', 'HEAD'])).stdout.trim() === firstRun.commit_sha,
);

const recoveryKit = await json('/cloud/recovery-kit', 'POST', { passphrase: 'integration recovery password' });
ok('recovery kit is independently encrypted', recoveryKit.schemaVersion === 1 && recoveryKit.cipher === 'aes-256-gcm' && !JSON.stringify(recoveryKit).includes('managed-secret-password'));
const auditLog = await request('/cloud/audit?limit=100');
ok('sensitive cloud operations are auditable', auditLog.items.some(item => item.action === 'cloud.recovery_kit_exported') && auditLog.items.some(item => item.action === 'backup.restore_queued'));

const storage = await request("/storage");
ok(
  "real storage statistics",
  storage.backupsUsed > 0 && storage.free > 0 && storage.root === backupRoot,
);

const changedSettings = {
  ...defaults,
  language: "es",
  appearance: "light",
  timezone: "Europe/Madrid",
  defaultSchedule: { ...defaults.defaultSchedule, timezone: "Europe/Madrid" },
};
await json("/settings", "PUT", changedSettings);
const storedSettings = await request("/settings");
ok(
  "settings persistence",
  storedSettings.language === "es" &&
    storedSettings.appearance === "light" &&
    storedSettings.timezone === "Europe/Madrid",
);

await delay(1100);
const secondRequest = await json("/backups/run", "POST", {
  branchIds: [branchId],
});
await waitForRun(secondRequest.items[0].id, "success");
let backupList = await request(`/backups?repositoryId=${repositoryId}`);
ok(
  "retention against real filesystem",
  backupList.items.length === 1 && backupList.items[0].id !== 1,
);
const retentionDatabase = new Database(databasePath, { readonly: true });
const retainedSnapshots = retentionDatabase.prepare("SELECT COUNT(*) count FROM snapshots").get().count;
const localReplicaStates = retentionDatabase.prepare("SELECT status,COUNT(*) count FROM backup_replicas WHERE target_id='local' GROUP BY status").all();
retentionDatabase.close();
ok(
  "retention preserves canonical snapshot history",
  retainedSnapshots === 2 &&
    localReplicaStates.some((row) => row.status === "deleted" && row.count === 1) &&
    localReplicaStates.some((row) => row.status === "verified" && row.count === 1),
);
try {
  await fs.access(firstRun.destination);
  throw new Error("old backup still exists");
} catch (error) {
  if (error.message === "old backup still exists") throw error;
}
let remoteDelete;
const remoteDeleteDeadline = Date.now() + 45_000;
while (Date.now() < remoteDeleteDeadline) {
  const transferList = await request('/cloud/transfers?limit=50');
  remoteDelete = transferList.items.find(item => item.snapshot_id === firstBackupId && item.operation === 'delete');
  if (remoteDelete?.status === 'success') break;
  if (remoteDelete?.status === 'failed') throw new Error(remoteDelete.error);
  await delay(250);
}
let remoteWasDeleted = false;
try { await fs.access(remoteArtifactPath); } catch { remoteWasDeleted = true; }
ok('retention queues and completes tracked remote replica deletion', remoteDelete?.status === 'success' && remoteWasDeleted);

const database = new Database(databasePath);
database
  .prepare("UPDATE branches SET next_run_at=? WHERE id=?")
  .run(new Date(Date.now() - 1000).toISOString(), branchId);
database.close();
const automaticDeadline = Date.now() + 40_000;
let automaticRun;
while (Date.now() < automaticDeadline) {
  const history = await request("/history?page=1&pageSize=100");
  automaticRun = history.items.find(
    (item) => item.branch_id === branchId && item.origin === "automatic",
  );
  if (automaticRun?.status === "success") break;
  if (automaticRun?.status === "failed") throw new Error(automaticRun.error);
  await delay(750);
}
ok("persistent automatic scheduler", automaticRun?.status === "success");
backupList = await request(`/backups?repositoryId=${repositoryId}`);
ok(
  "retention preserves latest valid backup",
  backupList.items.length === 1 &&
    (await fs.stat(backupList.items[0].path)).isDirectory(),
);

await json(`/repositories/${repositoryId}/branches`, "POST", {
  names: ["definitely-missing-branch-backmygit-test"],
});
const withMissing = await request(`/repositories/${repositoryId}`);
const missing = withMissing.branches.find(
  (branch) => branch.name === "definitely-missing-branch-backmygit-test",
);
const failedRequest = await json("/backups/run", "POST", {
  branchIds: [missing.id],
});
const failedRun = await waitForRun(failedRequest.items[0].id, "failed");
ok(
  "failed backup reporting",
  Boolean(failedRun.error) && !failedRun.commit_sha,
);
const missingBranchPath = path.join(backupRoot, "octocat_Hello-World");
const repositoryChildren = await fs.readdir(missingBranchPath);
ok(
  "failed backup leaves no valid destination",
  !repositoryChildren.some((name) => name.startsWith("definitely-missing")),
);

await json("/history", "DELETE");
const clearedHistory = await request("/history?page=1&pageSize=25");
backupList = await request(`/backups?repositoryId=${repositoryId}`);
ok(
  "clear history keeps backups",
  clearedHistory.total === 0 &&
    backupList.items.length === 1 &&
    (await fs.stat(backupList.items[0].path)).isDirectory(),
);

const survivingPath = backupList.items[0].path;
await json(`/repositories/${repositoryId}?deleteFiles=false`, "DELETE");
ok(
  "configuration deletion preserves files",
  (await fs.stat(survivingPath)).isDirectory(),
);

const recreated = await json("/repositories", "POST", {
  repositories: [
    {
      owner: "octocat",
      name: "Hello-World",
      description: "",
      stars: 0,
      visibility: "public",
      defaultBranch: "master",
      branchNames: ["master"],
    },
  ],
  schedule,
  retention,
});
const reconciliation = await json("/storage/reconcile", "POST");
const imported = await request(
  `/backups?repositoryId=${recreated.items[0].id}`,
);
ok(
  "filesystem reconciliation",
  reconciliation.discovered === 1 && imported.items.length === 1,
);

const raceReplicaId = randomUUID();
const raceJobId = randomUUID();
const raceLocation = `race/${imported.items[0].id}.tar.zst`;
const raceStamp = new Date().toISOString();
const raceDatabase = new Database(databasePath);
raceDatabase.prepare(`INSERT INTO backup_replicas(id,snapshot_id,target_id,status,location,required,created_at,updated_at)
  VALUES(?,?,?,'queued',?,1,?,?)`).run(raceReplicaId, imported.items[0].id, cloudTarget.id, raceLocation, raceStamp, raceStamp);
raceDatabase.prepare(`INSERT INTO transfer_jobs(id,replica_id,operation,status,attempts,bytes_transferred,created_at,updated_at)
  VALUES(?,?,'upload','queued',0,0,?,?)`).run(raceJobId, raceReplicaId, raceStamp, raceStamp);
raceDatabase.close();
await fs.writeFile(rcloneDelayFile, '4000');
const raceStartDeadline = Date.now() + 30_000;
let raceStarted = false;
while (Date.now() < raceStartDeadline) {
  const inspectRace = new Database(databasePath, { readonly: true });
  const state = inspectRace.prepare('SELECT status FROM backup_replicas WHERE id=?').get(raceReplicaId)?.status;
  inspectRace.close();
  if (state === 'uploading') { raceStarted = true; break; }
  await delay(100);
}
ok('delayed cloud upload reached the active transfer window', raceStarted);
await json(`/backups/${imported.items[0].id}?remote=true`, "DELETE");
await fs.rm(rcloneDelayFile, { force: true });
let raceDelete;
const raceDeleteDeadline = Date.now() + 45_000;
while (Date.now() < raceDeleteDeadline) {
  const transferList = await request('/cloud/transfers?limit=100');
  raceDelete = transferList.items.find(item => item.replica_id === raceReplicaId && item.operation === 'delete');
  if (raceDelete?.status === 'success') break;
  if (raceDelete?.status === 'failed') throw new Error(raceDelete.error);
  await delay(200);
}
const raceRemotePath = path.join(remoteRoot, cloudTarget.rootPath, ...raceLocation.split('/'));
let raceRemoteAbsent = false;
try { await fs.access(raceRemotePath); } catch { raceRemoteAbsent = true; }
const remoteEntries = await fs.readdir(remoteRoot, { recursive: true });
ok(
  'remote deletion intent survives an active upload and removes final and partial objects',
  raceDelete?.status === 'success' && raceRemoteAbsent && !remoteEntries.some(entry => String(entry).includes(raceJobId)),
);
const deletedReplicaDatabase = new Database(databasePath, { readonly: true });
const deletedReplica = deletedReplicaDatabase.prepare(`SELECT s.id,lr.status FROM snapshots s
  JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' WHERE s.id=?`).get(imported.items[0].id);
deletedReplicaDatabase.close();
ok(
  "local deletion preserves canonical snapshot",
  deletedReplica?.id === imported.items[0].id && deletedReplica?.status === "deleted",
);

await json(`/repositories/${recreated.items[0].id}?deleteFiles=true`, "DELETE");
try {
  await fs.access(path.join(backupRoot, "octocat_Hello-World"));
  throw new Error("repository directory still exists");
} catch (error) {
  if (error.message === "repository directory still exists") throw error;
}
ok("explicit file deletion", true);

console.log(`\n${checks.length} integration checks passed.`);
