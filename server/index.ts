import fs from "node:fs/promises";
import path from "node:path";
import compression from "compression";
import express from "express";
import helmet from "helmet";
import api from "./api.js";
import { config } from "./config.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { reconcileFilesystem } from "./storage.js";
import { startWorker, stopWorker } from "./worker.js";

await fs.mkdir(config.backupRoot, { recursive: true });
await fs.mkdir(config.dataDir, { recursive: true });
const temporaryRoot = path.join(config.backupRoot, ".tmp");
await fs.mkdir(temporaryRoot, { recursive: true });
for (const stale of await fs.readdir(temporaryRoot)) {
  await fs.rm(path.join(temporaryRoot, stale), {
    recursive: true,
    force: true,
  });
}
await reconcileFilesystem();

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use("/api", api);

if (config.isProduction) {
  const webRoot = path.resolve("dist");
  app.use(
    express.static(webRoot, { maxAge: "1y", immutable: true, index: false }),
  );
  app.get("*", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
}

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    `BackMyGit ${config.appVersion} listening on :${config.port}; backups: ${config.backupRoot}`,
  );
});
startWorker();
startScheduler();

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  stopScheduler();
  server.close();
  await stopWorker();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
