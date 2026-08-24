import fs from "node:fs/promises";
import path from "node:path";
import compression from "compression";
import express from "express";
import helmet from "helmet";
import api from "./api.js";
import auth, { authContext, authorizeApi, ensureBootstrapToken, requireAuth } from './auth.js';
import { config } from "./config.js";
import { errorHandler } from './errors.js';
import { csrfProtection, hostGuard, httpsGuard, requestContext } from './security.js';
import { startScheduler, stopScheduler } from "./scheduler.js";
import { reconcileFilesystem } from "./storage.js";
import { startWorker, stopWorker } from "./worker.js";

await fs.mkdir(config.backupRoot, { recursive: true });
await fs.mkdir(config.dataDir, { recursive: true });
await ensureBootstrapToken();
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
app.set('trust proxy', config.trustedProxies.length ? config.trustedProxies : false);
app.use(requestContext);
app.use(hostGuard);
app.use(httpsGuard);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: config.forceHttps ? [] : null,
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use('/api', authContext, csrfProtection);
app.use('/api/auth', auth);
app.use('/api', (req, res, next) => req.path === '/health' ? next() : requireAuth(req, res, next));
app.use('/api', (req, res, next) => req.path === '/health' ? next() : authorizeApi(req, res, next), api);

if (config.isProduction) {
  const webRoot = path.resolve("dist");
  app.use(
    express.static(webRoot, { maxAge: "1y", immutable: true, index: false }),
  );
  app.get("*", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
}
app.use(errorHandler);

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
