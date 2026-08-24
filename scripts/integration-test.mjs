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
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
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
  headers: { "Content-Type": "application/json" },
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

await json(`/repositories/${recreated.items[0].id}?deleteFiles=true`, "DELETE");
try {
  await fs.access(path.join(backupRoot, "octocat_Hello-World"));
  throw new Error("repository directory still exists");
} catch (error) {
  if (error.message === "repository directory still exists") throw error;
}
ok("explicit file deletion", true);

console.log(`\n${checks.length} integration checks passed.`);
