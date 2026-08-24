import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import argon2 from 'argon2';
import { parse, serialize } from 'cookie';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';

export type Role = 'admin' | 'operator' | 'viewer';
export interface AuthenticatedUser {
  id: number;
  username: string;
  role: Role;
}

const router = Router();
const safeAsync =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    void fn(req, res, next).catch(next);
const usernameSchema = z.string().trim().min(3).max(64).regex(/^[\p{L}\p{N}_.-]+$/u);
const passwordSchema = z.string().min(12).max(256);
const sessionCookieName = config.forceHttps ? '__Host-backmygit_session' : 'backmygit_session';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function usersExist(): boolean {
  return Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
}

export async function ensureBootstrapToken(): Promise<void> {
  if (usersExist()) {
    await fs.rm(config.bootstrapTokenPath, { force: true });
    return;
  }
  try {
    await fs.access(config.bootstrapTokenPath);
    return;
  } catch {
    const token = randomBytes(32).toString('base64url');
    await fs.writeFile(config.bootstrapTokenPath, `${token}\n`, { flag: 'wx', mode: 0o600 });
    console.warn(`Initial setup required. Read the one-time token inside the container at ${config.bootstrapTokenPath}`);
  }
}

export function audit(
  action: string,
  req: Request,
  detail: Record<string, unknown> = {},
  targetType?: string,
  targetId?: string,
): void {
  db.prepare(`INSERT INTO audit_events(user_id,action,target_type,target_id,ip_address,detail_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(
      req.user?.id || null,
      action,
      targetType || null,
      targetId || null,
      req.ip || null,
      JSON.stringify(detail),
      new Date().toISOString(),
    );
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return serialize(sessionCookieName, token, {
    httpOnly: true,
    secure: config.forceHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

function clearSessionCookie(): string {
  return serialize(sessionCookieName, '', {
    httpOnly: true,
    secure: config.forceHttps,
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
  });
}

function createSession(req: Request, userId: number) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const idleExpires = new Date(now.getTime() + config.sessionIdleMs);
  const absoluteExpires = new Date(now.getTime() + config.sessionAbsoluteMs);
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions(id,token_hash,user_id,csrf_token,ip_address,user_agent,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      sha256(token),
      userId,
      csrfToken,
      req.ip || null,
      String(req.get('user-agent') || '').slice(0, 500) || null,
      now.toISOString(),
      now.toISOString(),
      idleExpires.toISOString(),
      absoluteExpires.toISOString(),
    );
  return { id, token, csrfToken, absoluteExpires };
}

export const authContext = safeAsync(async (req, res, next) => {
  const token = parse(req.headers.cookie || '')[sessionCookieName];
  if (!token) return next();
  const session = db.prepare(`SELECT s.*,u.username,u.role,u.disabled_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha256(token)) as any;
  if (!session) {
    res.appendHeader('Set-Cookie', clearSessionCookie());
    return next();
  }
  const now = new Date();
  if (
    session.disabled_at ||
    new Date(session.idle_expires_at) <= now ||
    new Date(session.absolute_expires_at) <= now
  ) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
    res.appendHeader('Set-Cookie', clearSessionCookie());
    return next();
  }
  req.user = { id: session.user_id, username: session.username, role: session.role };
  req.sessionId = session.id;
  req.csrfToken = session.csrf_token;
  if (now.getTime() - new Date(session.last_seen_at).getTime() > 60_000) {
    const idleExpiry = new Date(Math.min(
      now.getTime() + config.sessionIdleMs,
      new Date(session.absolute_expires_at).getTime(),
    ));
    db.prepare('UPDATE sessions SET last_seen_at=?,idle_expires_at=? WHERE id=?')
      .run(now.toISOString(), idleExpiry.toISOString(), session.id);
  }
  next();
});

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!usersExist()) return next(Object.assign(new Error('Initial setup is required'), { status: 503, code: 'SETUP_REQUIRED' }));
  if (!req.user) return next(Object.assign(new Error('Authentication required'), { status: 401, code: 'AUTH_REQUIRED' }));
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role))
      return next(Object.assign(new Error('Insufficient permissions'), { status: 403, code: 'FORBIDDEN' }));
    next();
  };
}

const operatorMutations = new Set([
  'POST /backups/run',
  'POST /storage/reconcile',
]);

export function authorizeApi(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(Object.assign(new Error('Authentication required'), { status: 401 }));
  if (req.user.role === 'admin' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.user.role === 'operator' && operatorMutations.has(`${req.method} ${req.path}`)) return next();
  next(Object.assign(new Error('Insufficient permissions'), { status: 403, code: 'FORBIDDEN' }));
}

const loginLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many authentication attempts', code: 'RATE_LIMITED' },
});

router.get('/setup-status', (_req, res) => {
  res.json({
    required: !usersExist(),
    secureContext: config.forceHttps,
    publicUrlConfigured: Boolean(config.publicUrl),
  });
});

router.post('/setup', loginLimit, safeAsync(async (req, res) => {
  if (usersExist()) throw Object.assign(new Error('Initial setup is already complete'), { status: 409 });
  const body = z.object({
    token: z.string().min(20).max(200),
    username: usernameSchema,
    password: passwordSchema,
  }).parse(req.body);
  const expected = (await fs.readFile(config.bootstrapTokenPath, 'utf8')).trim();
  if (!equalSecret(body.token, expected)) {
    audit('auth.setup_failed', req, { username: body.username });
    throw Object.assign(new Error('Invalid bootstrap token'), { status: 401, code: 'INVALID_BOOTSTRAP_TOKEN' });
  }
  const now = new Date().toISOString();
  const passwordHash = await argon2.hash(body.password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const userId = db.transaction(() => {
    if (usersExist()) throw Object.assign(new Error('Initial setup is already complete'), { status: 409 });
    return Number(db.prepare(`INSERT INTO users(username,password_hash,role,created_at,updated_at)
      VALUES(?,?,'admin',?,?)`).run(body.username, passwordHash, now, now).lastInsertRowid);
  })();
  await fs.rm(config.bootstrapTokenPath, { force: true });
  req.user = { id: userId, username: body.username, role: 'admin' };
  const session = createSession(req, userId);
  audit('auth.setup_completed', req);
  res.setHeader('Set-Cookie', sessionCookie(session.token, Math.floor(config.sessionAbsoluteMs / 1000)));
  res.status(201).json({ user: req.user, csrfToken: session.csrfToken });
}));

router.post('/login', loginLimit, safeAsync(async (req, res) => {
  if (!usersExist()) throw Object.assign(new Error('Initial setup is required'), { status: 503, code: 'SETUP_REQUIRED' });
  const body = z.object({ username: usernameSchema, password: z.string().min(1).max(256) }).parse(req.body);
  const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(body.username) as any;
  const valid = user && !user.disabled_at && await argon2.verify(user.password_hash, body.password);
  if (!valid) {
    audit('auth.login_failed', req, { username: body.username });
    throw Object.assign(new Error('Invalid username or password'), { status: 401, code: 'INVALID_CREDENTIALS' });
  }
  req.user = { id: user.id, username: user.username, role: user.role };
  const session = createSession(req, user.id);
  db.prepare('UPDATE users SET last_login_at=?,updated_at=? WHERE id=?')
    .run(new Date().toISOString(), new Date().toISOString(), user.id);
  audit('auth.login_succeeded', req, {}, 'session', session.id);
  res.setHeader('Set-Cookie', sessionCookie(session.token, Math.floor(config.sessionAbsoluteMs / 1000)));
  res.json({ user: req.user, csrfToken: session.csrfToken });
}));

router.get('/session', requireAuth, (req, res) => {
  res.json({ user: req.user, csrfToken: req.csrfToken });
});

router.post('/logout', requireAuth, (req, res) => {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id=?').run(req.sessionId);
  audit('auth.logout', req, {}, 'session', req.sessionId);
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

router.put('/password', requireAuth, safeAsync(async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).parse(req.body);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id) as any;
  if (!await argon2.verify(user.password_hash, body.currentPassword))
    throw Object.assign(new Error('Current password is incorrect'), { status: 403, code: 'INVALID_PASSWORD' });
  const passwordHash = await argon2.hash(body.newPassword, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?')
      .run(passwordHash, new Date().toISOString(), req.user!.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(req.user!.id, req.sessionId);
  })();
  audit('auth.password_changed', req);
  res.json({ ok: true });
}));

router.get('/sessions', requireAuth, (req, res) => {
  const items = db.prepare(`SELECT id,ip_address,user_agent,created_at,last_seen_at,idle_expires_at,absolute_expires_at
    FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC`).all(req.user!.id) as any[];
  res.json({ items: items.map((item) => ({ ...item, current: item.id === req.sessionId })) });
});

router.delete('/sessions/:id', requireAuth, (req, res) => {
  const sessionId = z.string().uuid().parse(req.params.id);
  const removed = db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(sessionId, req.user!.id);
  if (!removed.changes) throw Object.assign(new Error('Session not found'), { status: 404 });
  audit('auth.session_revoked', req, {}, 'session', sessionId);
  if (sessionId === req.sessionId) res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

export default router;
