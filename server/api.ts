import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import archiver from "archiver";
import { z } from "zod";
import { config } from "./config.js";
import { db, getSettings, json, setSettings } from "./db.js";
import { listBranches, searchRepositories } from "./github.js";
import { isWithin, repositoryDirectory } from "./paths.js";
import { applyAllRetention } from "./retention.js";
import { refreshNextRuns } from "./scheduler.js";
import {
  deleteBackupRecord,
  reconcileFilesystem,
  resolveRealBackupPath,
  storageStats,
} from "./storage.js";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from "./types.js";
import { isValidTimezone, searchTimezoneLocations } from "./timezones.js";
import { enqueueBackup } from "./worker.js";

const router = Router();
const asyncRoute =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    void fn(req, res, next).catch(next);
const id = (value: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw Object.assign(new Error("Invalid identifier"), { status: 400 });
  return parsed;
};

const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidTimezone, "Invalid IANA timezone");
const scheduleSchema = z.object({
  enabled: z.boolean(),
  type: z.enum([
    "daily",
    "weekly",
    "monthly",
    "interval_days",
    "interval_weeks",
    "interval_months",
  ]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: timezoneSchema,
  interval: z.number().int().min(1).max(365),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  dayOfMonth: z.number().int().min(1).max(31),
});
const retentionSchema = z.object({
  mode: z.enum(["forever", "age", "latest", "combined"]),
  ageValue: z.number().int().min(1).max(10000),
  ageUnit: z.enum(["days", "weeks", "months"]),
  keepLatest: z.number().int().min(1).max(10000),
  minimumToKeep: z.number().int().min(1).max(10000),
});

router.get(
  "/health",
  asyncRoute(async (_req, res) => {
    db.prepare("SELECT 1").get();
    await fs.access(config.backupRoot, config.processRole === 'web' ? fs.constants.R_OK : fs.constants.R_OK | fs.constants.W_OK);
    res.json({ status: "ok", version: config.appVersion, role: config.processRole });
  }),
);

router.get(
  "/github/search",
  asyncRoute(async (req, res) => {
    const query = z.string().trim().min(2).max(120).parse(req.query.q);
    res.json({ items: await searchRepositories(query) });
  }),
);

router.get(
  "/github/repos/:owner/:repo/branches",
  asyncRoute(async (req, res) => {
    const owner = z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .parse(req.params.owner);
    const repo = z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .parse(req.params.repo);
    res.json({ items: await listBranches(owner, repo) });
  }),
);

router.get(
  "/locations/timezones",
  asyncRoute(async (req, res) => {
    const query = z.string().trim().min(2).max(100).parse(req.query.q);
    const language = z.enum(["en", "es"]).default("en").parse(req.query.language);
    res.json({ items: await searchTimezoneLocations(query, language) });
  }),
);

router.get(
  "/dashboard",
  asyncRoute(async (_req, res) => {
    const counts = db
      .prepare(
        `SELECT
    (SELECT COUNT(*) FROM repositories WHERE enabled=1) protectedRepositories,
    (SELECT COUNT(*) FROM branches WHERE enabled=1 AND configured=1) protectedBranches,
    (SELECT COUNT(*) FROM backup_replicas WHERE target_id='local' AND status='verified') totalBackups,
    (SELECT COUNT(*) FROM runs WHERE status='success') successfulBackups,
    (SELECT COUNT(*) FROM runs WHERE status='failed') failedBackups,
    (SELECT COALESCE(SUM(size_bytes),0) FROM backup_replicas WHERE target_id='local' AND status='verified') totalBytes,
    (SELECT MAX(completed_at) FROM runs WHERE status='success') lastCompleted,
    (SELECT MIN(next_run_at) FROM branches WHERE enabled=1 AND configured=1) nextScheduled`,
      )
      .get();
    const recent = db
      .prepare(
        `SELECT ru.*, r.owner, r.name repository, br.name branch FROM runs ru
    JOIN repositories r ON r.id=ru.repository_id JOIN branches br ON br.id=ru.branch_id ORDER BY ru.created_at DESC LIMIT 8`,
      )
      .all();
    const attention = db
      .prepare(
        `SELECT r.id,r.owner,r.name,r.enabled,MAX(ru.completed_at) lastAttempt,
    (SELECT status FROM runs x WHERE x.repository_id=r.id ORDER BY x.created_at DESC LIMIT 1) lastStatus
    FROM repositories r LEFT JOIN runs ru ON ru.repository_id=r.id GROUP BY r.id
    HAVING r.enabled=0 OR lastStatus='failed' ORDER BY lastAttempt DESC LIMIT 8`,
      )
      .all();
    res.json({ counts, recent, attention });
  }),
);

router.get("/repositories", (_req, res) => {
  const items = db
    .prepare(
      `SELECT r.*,
    (SELECT COUNT(*) FROM branches br WHERE br.repository_id=r.id AND br.configured=1) branchCount,
    (SELECT COUNT(*) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.repository_id=r.id) backupCount,
    (SELECT COALESCE(SUM(lr.size_bytes),0) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.repository_id=r.id) sizeBytes,
    (SELECT MAX(s.completed_at) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.repository_id=r.id) lastBackup,
    (SELECT MIN(br.next_run_at) FROM branches br WHERE br.repository_id=r.id AND br.enabled=1 AND br.configured=1) nextBackup,
    (SELECT status FROM runs ru WHERE ru.repository_id=r.id ORDER BY ru.created_at DESC LIMIT 1) lastStatus
    FROM repositories r ORDER BY r.owner COLLATE NOCASE,r.name COLLATE NOCASE`,
    )
    .all();
  res.json({
    items: items.map((row: any) => ({
      ...row,
      schedule: JSON.parse(row.schedule_json),
      retention: JSON.parse(row.retention_json),
    })),
  });
});

router.post(
  "/repositories",
  asyncRoute(async (req, res) => {
    const settings = getSettings();
    const body = z
      .object({
        repositories: z
          .array(
            z.object({
              owner: z.string().regex(/^[A-Za-z0-9-]+$/),
              name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
              description: z.string().optional().default(""),
              stars: z.number().int().optional().default(0),
              visibility: z.string().optional().default("public"),
              defaultBranch: z.string().min(1),
              branchNames: z.array(z.string().min(1)).optional(),
              allBranches: z.boolean().optional().default(false),
            }),
          )
          .min(1)
          .max(30),
        schedule: scheduleSchema.optional(),
        retention: retentionSchema.optional(),
      })
      .parse(req.body);
    const created: any[] = [];
    for (const item of body.repositories) {
      const schedule = body.schedule || settings.defaultSchedule;
      const retention = body.retention || settings.defaultRetention;
      let names = item.branchNames?.length
        ? item.branchNames
        : [item.defaultBranch];
      if (item.allBranches)
        names = (await listBranches(item.owner, item.name)).map(
          (branch) => branch.name,
        );
      const now = new Date().toISOString();
      const result = db
        .prepare(
          `INSERT INTO repositories(owner,name,url,description,stars,visibility,default_branch,schedule_json,retention_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,name) DO UPDATE SET url=excluded.url,description=excluded.description,
      stars=excluded.stars,visibility=excluded.visibility,default_branch=excluded.default_branch,enabled=1,
      schedule_json=excluded.schedule_json,retention_json=excluded.retention_json,updated_at=excluded.updated_at RETURNING id`,
        )
        .get(
          item.owner,
          item.name,
          `https://github.com/${item.owner}/${item.name}`,
          item.description,
          item.stars,
          item.visibility,
          item.defaultBranch,
          json(schedule),
          json(retention),
          now,
          now,
        ) as any;
      const addBranch =
        db.prepare(`INSERT INTO branches(repository_id,name,enabled,configured,created_at) VALUES(?,?,1,1,?)
      ON CONFLICT(repository_id,name) DO UPDATE SET configured=1,enabled=1`);
      for (const name of [...new Set(names)])
        addBranch.run(result.id, name, now);
      refreshNextRuns(result.id);
      created.push({ id: result.id, owner: item.owner, name: item.name });
    }
    res.status(201).json({ items: created });
  }),
);

router.get("/repositories/:id", (req, res) => {
  const repositoryId = id(String(req.params.id));
  const row = db
    .prepare(
      `SELECT r.*,
    (SELECT COUNT(*) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.repository_id=r.id) backupCount,
    (SELECT COALESCE(SUM(lr.size_bytes),0) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.repository_id=r.id) sizeBytes,
    (SELECT MAX(s.completed_at) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.repository_id=r.id) lastBackup,
    (SELECT MIN(br.next_run_at) FROM branches br WHERE br.repository_id=r.id AND br.enabled=1 AND br.configured=1) nextBackup
    FROM repositories r WHERE r.id=?`,
    )
    .get(repositoryId) as any;
  if (!row)
    throw Object.assign(new Error("Repository not found"), { status: 404 });
  const branches = db
    .prepare(
      `SELECT br.*,
    (SELECT COUNT(*) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.branch_id=br.id) backupCount,
    (SELECT COALESCE(SUM(lr.size_bytes),0) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.branch_id=br.id) sizeBytes,
    (SELECT MAX(s.completed_at) FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.branch_id=br.id) lastBackup,
    (SELECT status FROM runs ru WHERE ru.branch_id=br.id ORDER BY ru.created_at DESC LIMIT 1) lastStatus
    FROM branches br WHERE br.repository_id=? ORDER BY br.configured DESC,br.name`,
    )
    .all(repositoryId) as any[];
  const history = db
    .prepare(
      `SELECT ru.*,br.name branch FROM runs ru JOIN branches br ON br.id=ru.branch_id WHERE ru.repository_id=? ORDER BY ru.created_at DESC LIMIT 15`,
    )
    .all(repositoryId);
  res.json({
    ...row,
    schedule: JSON.parse(row.schedule_json),
    retention: JSON.parse(row.retention_json),
    branches: branches.map((branch) => ({
      ...branch,
      schedule: branch.schedule_json ? JSON.parse(branch.schedule_json) : null,
      retention: branch.retention_json
        ? JSON.parse(branch.retention_json)
        : null,
    })),
    history,
  });
});

router.patch("/repositories/:id", (req, res) => {
  const repositoryId = id(String(req.params.id));
  const body = z
    .object({
      enabled: z.boolean().optional(),
      schedule: scheduleSchema.optional(),
      retention: retentionSchema.optional(),
    })
    .parse(req.body);
  const current = db
    .prepare("SELECT * FROM repositories WHERE id=?")
    .get(repositoryId) as any;
  if (!current)
    throw Object.assign(new Error("Repository not found"), { status: 404 });
  db.prepare(
    "UPDATE repositories SET enabled=?,schedule_json=?,retention_json=?,updated_at=? WHERE id=?",
  ).run(
    body.enabled === undefined ? current.enabled : Number(body.enabled),
    json(body.schedule || JSON.parse(current.schedule_json)),
    json(body.retention || JSON.parse(current.retention_json)),
    new Date().toISOString(),
    repositoryId,
  );
  refreshNextRuns(repositoryId);
  res.json({ ok: true });
});

router.get(
  "/repositories/:id/available-branches",
  asyncRoute(async (req, res) => {
    const repositoryId = id(String(req.params.id));
    const repo = db
      .prepare("SELECT owner,name FROM repositories WHERE id=?")
      .get(repositoryId) as any;
    if (!repo)
      throw Object.assign(new Error("Repository not found"), { status: 404 });
    const configured = new Map(
      (
        db
          .prepare("SELECT name,configured FROM branches WHERE repository_id=?")
          .all(repositoryId) as any[]
      ).map((x) => [x.name, Boolean(x.configured)]),
    );
    const branches = await listBranches(repo.owner, repo.name);
    res.json({
      items: branches.map((branch) => ({
        ...branch,
        configured: configured.get(branch.name) || false,
      })),
    });
  }),
);

router.post("/repositories/:id/branches", (req, res) => {
  const repositoryId = id(String(req.params.id));
  const names = z
    .object({ names: z.array(z.string().min(1).max(250)).min(1).max(200) })
    .parse(req.body).names;
  const now = new Date().toISOString();
  const statement =
    db.prepare(`INSERT INTO branches(repository_id,name,enabled,configured,created_at) VALUES(?,?,1,1,?)
    ON CONFLICT(repository_id,name) DO UPDATE SET configured=1,enabled=1`);
  db.transaction(() => {
    for (const name of [...new Set(names)])
      statement.run(repositoryId, name, now);
  })();
  refreshNextRuns(repositoryId);
  res.status(201).json({ ok: true });
});

router.patch("/branches/:id", (req, res) => {
  const branchId = id(String(req.params.id));
  const body = z
    .object({
      enabled: z.boolean().optional(),
      configured: z.boolean().optional(),
      schedule: scheduleSchema.nullable().optional(),
      retention: retentionSchema.nullable().optional(),
    })
    .parse(req.body);
  const row = db
    .prepare("SELECT * FROM branches WHERE id=?")
    .get(branchId) as any;
  if (!row) throw Object.assign(new Error("Branch not found"), { status: 404 });
  db.prepare(
    "UPDATE branches SET enabled=?,configured=?,schedule_json=?,retention_json=? WHERE id=?",
  ).run(
    body.enabled === undefined ? row.enabled : Number(body.enabled),
    body.configured === undefined ? row.configured : Number(body.configured),
    body.schedule === undefined
      ? row.schedule_json
      : body.schedule
        ? json(body.schedule)
        : null,
    body.retention === undefined
      ? row.retention_json
      : body.retention
        ? json(body.retention)
        : null,
    branchId,
  );
  refreshNextRuns(row.repository_id);
  res.json({ ok: true });
});

router.post("/backups/run", (req, res) => {
  const body = z
    .object({
      repositoryId: z.number().int().positive().optional(),
      branchIds: z.array(z.number().int().positive()).optional(),
    })
    .refine((x) => x.repositoryId || x.branchIds?.length)
    .parse(req.body);
  const branchIds =
    body.branchIds ||
    (
      db
        .prepare(
          "SELECT id FROM branches WHERE repository_id=? AND enabled=1 AND configured=1",
        )
        .all(body.repositoryId) as any[]
    ).map((x) => x.id);
  const runs = branchIds.map((branchId) => enqueueBackup(branchId, "manual"));
  res.status(202).json({ items: runs });
});

router.get("/backups", (req, res) => {
  const clauses: string[] = ["s.status='success'", "lr.target_id='local'", "lr.status='verified'"];
  const params: any[] = [];
  if (req.query.repositoryId) {
    clauses.push("s.repository_id=?");
    params.push(id(String(req.query.repositoryId)));
  }
  if (req.query.branch) {
    clauses.push("br.name LIKE ?");
    params.push(`%${String(req.query.branch).slice(0, 100)}%`);
  }
  const items = db
    .prepare(
      `SELECT s.*,lr.location path,lr.size_bytes,r.owner,r.name repository,br.name branch
    FROM snapshots s JOIN backup_replicas lr ON lr.snapshot_id=s.id
    JOIN repositories r ON r.id=s.repository_id JOIN branches br ON br.id=s.branch_id
    WHERE ${clauses.join(" AND ")} ORDER BY s.completed_at DESC`,
    )
    .all(...params);
  res.json({ items });
});

router.get(
  "/backups/:id/contents",
  asyncRoute(async (req, res) => {
    const backup = db
      .prepare(`SELECT lr.location path FROM snapshots s JOIN backup_replicas lr
        ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.id=?`)
      .get(id(String(req.params.id))) as any;
    if (!backup)
      throw Object.assign(new Error("Backup not found"), { status: 404 });
    const relative = String(req.query.path || "");
    const target = path.resolve(backup.path, relative);
    if (target !== path.resolve(backup.path) && !isWithin(backup.path, target))
      throw Object.assign(new Error("Invalid path"), { status: 400 });
    const safeTarget = await resolveRealBackupPath(backup.path, target, true);
    const entries = await fs.readdir(safeTarget, { withFileTypes: true });
    const items = await Promise.all(
      entries.slice(0, 500).map(async (entry) => {
        const stat = await fs.lstat(path.join(safeTarget, entry.name));
        return {
          name: entry.name,
          type: entry.isSymbolicLink()
            ? "symlink"
            : entry.isDirectory()
              ? "directory"
              : "file",
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      }),
    );
    res.json({
      path: relative,
      items: items.sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "directory"
            ? -1
            : 1,
      ),
      truncated: entries.length > 500,
    });
  }),
);

router.get(
  "/backups/:id/download",
  asyncRoute(async (req, res) => {
    const backup = db
      .prepare(
        `SELECT lr.location path,r.owner,r.name repository,br.name branch FROM snapshots s
        JOIN backup_replicas lr ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified'
        JOIN repositories r ON r.id=s.repository_id JOIN branches br ON br.id=s.branch_id WHERE s.id=?`,
      )
      .get(id(String(req.params.id))) as any;
    if (!backup)
      throw Object.assign(new Error("Backup not found"), { status: 404 });
    const safeBackupPath = await resolveRealBackupPath(config.backupRoot, backup.path);
    res.attachment(
      `${backup.owner}_${backup.repository}_${backup.branch.replaceAll("/", "__")}.zip`,
    );
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (error) => res.destroy(error));
    archive.pipe(res);
    archive.glob("**/*", { cwd: safeBackupPath, dot: true, follow: false });
    void archive.finalize();
  }),
);

router.get(
  "/backups/:id/file",
  asyncRoute(async (req, res) => {
    const backup = db
      .prepare(`SELECT lr.location path FROM snapshots s JOIN backup_replicas lr
        ON lr.snapshot_id=s.id AND lr.target_id='local' AND lr.status='verified' WHERE s.id=?`)
      .get(id(String(req.params.id))) as any;
    if (!backup)
      throw Object.assign(new Error("Backup not found"), { status: 404 });
    const target = path.resolve(
      backup.path,
      z.string().min(1).parse(req.query.path),
    );
    if (!isWithin(backup.path, target))
      throw Object.assign(new Error("Invalid file"), { status: 400 });
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Object.assign(new Error("Invalid file"), { status: 400 });
    const safeTarget = await resolveRealBackupPath(backup.path, target);
    res.download(safeTarget);
  }),
);

router.delete(
  "/backups/:id",
  asyncRoute(async (req, res) => {
    await deleteBackupRecord(id(String(req.params.id)));
    res.json({ ok: true });
  }),
);
router.post(
  "/backups/delete",
  asyncRoute(async (req, res) => {
    const ids = z
      .object({ ids: z.array(z.number().int().positive()).min(1).max(100) })
      .parse(req.body).ids;
    for (const backupId of ids) await deleteBackupRecord(backupId);
    res.json({ ok: true, deleted: ids.length });
  }),
);

router.get("/history", (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(
    100,
    Math.max(10, Number(req.query.pageSize || 25)),
  );
  const clauses = ["1=1"];
  const params: any[] = [];
  if (req.query.repositoryId) {
    clauses.push("ru.repository_id=?");
    params.push(id(String(req.query.repositoryId)));
  }
  if (req.query.branch) {
    clauses.push("br.name LIKE ?");
    params.push(`%${String(req.query.branch).slice(0, 100)}%`);
  }
  if (req.query.status) {
    clauses.push("ru.status=?");
    params.push(
      z
        .enum(["queued", "running", "success", "failed"])
        .parse(req.query.status),
    );
  }
  if (req.query.search) {
    clauses.push("(r.owner LIKE ? OR r.name LIKE ? OR ru.commit_sha LIKE ?)");
    const q = `%${String(req.query.search).slice(0, 100)}%`;
    params.push(q, q, q);
  }
  if (req.query.from) {
    clauses.push("ru.created_at>=?");
    params.push(z.string().datetime().parse(req.query.from));
  }
  if (req.query.to) {
    clauses.push("ru.created_at<=?");
    params.push(z.string().datetime().parse(req.query.to));
  }
  const where = clauses.join(" AND ");
  const total = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) total FROM runs ru JOIN repositories r ON r.id=ru.repository_id JOIN branches br ON br.id=ru.branch_id WHERE ${where}`,
        )
        .get(...params) as any
    ).total,
  );
  const items = db
    .prepare(
      `SELECT ru.*,r.owner,r.name repository,br.name branch FROM runs ru JOIN repositories r ON r.id=ru.repository_id
    JOIN branches br ON br.id=ru.branch_id WHERE ${where} ORDER BY ru.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({
    items,
    page,
    pageSize,
    total,
    pages: Math.ceil(total / pageSize),
  });
});

router.delete("/history", (req, res) => {
  const result = db
    .prepare("DELETE FROM runs WHERE status NOT IN ('queued','running')")
    .run();
  res.json({ ok: true, deleted: result.changes, backupsUntouched: true });
});

router.get(
  "/storage",
  asyncRoute(async (_req, res) => res.json(await storageStats())),
);
router.post(
  "/storage/reconcile",
  asyncRoute(async (_req, res) => res.json(await reconcileFilesystem())),
);
router.post(
  "/storage/retention",
  asyncRoute(async (_req, res) =>
    res.json({ deleted: await applyAllRetention() }),
  ),
);

router.get("/settings", (_req, res) => res.json(getSettings()));
router.put("/settings", (req, res) => {
  const settingsSchema = z.object({
    timezone: timezoneSchema,
    language: z.enum(["en", "es"]),
    appearance: z.enum(["light", "dark", "system"]),
    defaultBranchMode: z.enum(["default", "all"]),
    defaultSchedule: scheduleSchema,
    defaultRetention: retentionSchema,
  });
  const settings = settingsSchema.parse(req.body) as AppSettings;
  setSettings(settings);
  res.json(settings);
});
router.get("/settings/defaults", (_req, res) => res.json(DEFAULT_SETTINGS));

router.delete(
  "/repositories/:id",
  asyncRoute(async (req, res) => {
    const repositoryId = id(String(req.params.id));
    const deleteFiles = req.query.deleteFiles === "true";
    const repo = db
      .prepare("SELECT owner,name FROM repositories WHERE id=?")
      .get(repositoryId) as any;
    if (!repo)
      throw Object.assign(new Error("Repository not found"), { status: 404 });
    const active = db
      .prepare(
        "SELECT 1 FROM runs WHERE repository_id=? AND status IN ('queued','running')",
      )
      .get(repositoryId);
    if (active)
      throw Object.assign(new Error("Wait for active backups to finish"), {
        status: 409,
      });
    if (deleteFiles) {
      const target = path.join(
        config.backupRoot,
        repositoryDirectory(repo.owner, repo.name),
      );
      if (!isWithin(config.backupRoot, target))
        throw new Error("Invalid repository backup path");
      await fs.rm(target, { recursive: true, force: true });
    }
    db.prepare("DELETE FROM repositories WHERE id=?").run(repositoryId);
    res.json({ ok: true, filesDeleted: deleteFiles });
  }),
);

router.use((error: any, req: Request, res: Response, _next: NextFunction) => {
  const validation = error instanceof z.ZodError;
  const status = validation ? 400 : Number(error.status || 500);
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: validation
      ? "Validation failed"
      : error.message || "Unexpected error",
    code: validation ? "VALIDATION_ERROR" : error.code,
    details: validation ? error.flatten() : undefined,
    requestId: req.requestId,
  });
});

export default router;
