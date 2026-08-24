import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";

const exec = promisify(execFile);
const base = process.env.TEST_BASE_URL;
const backupRoot = process.env.TEST_BACKUP_ROOT;
const databasePath = process.env.TEST_DATABASE_PATH;
if (!base || !backupRoot || !databasePath)
  throw new Error(
    "TEST_BASE_URL, TEST_BACKUP_ROOT and TEST_DATABASE_PATH are required",
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

await json(`/backups/${imported.items[0].id}`, "DELETE");
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
