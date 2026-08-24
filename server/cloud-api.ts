import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from './auth.js';
import { browseRemote, cloudProviders, getConnection, testCloudConnection, validateCloudEndpoint } from './cloud.js';
import { db, getSettings } from './db.js';
import { assertRemoteName, obscureRcloneSecret } from './rclone.js';
import { normalizeRemoteSubpath } from './rclone-config.js';
import { deleteSecrets, putSecret } from './secrets.js';

const router = Router();
const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => void fn(req, res, next).catch(next);
const identifier = z.string().uuid();
const label = z.string().trim().min(1).max(100);

function publicConnection(row: any) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    remoteName: row.remote_name,
    authType: row.auth_type,
    status: row.status,
    managed: Boolean(row.managed),
    settings: JSON.parse(row.config_json || '{}'),
    lastTestedAt: row.last_tested_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/providers', (_req, res) => res.json({ items: cloudProviders }));

router.get('/connections', (_req, res) => {
  const rows = db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM storage_targets t WHERE t.connection_id=c.id) target_count
    FROM cloud_connections c ORDER BY c.name COLLATE NOCASE`).all() as any[];
  res.json({ items: rows.map(row => ({ ...publicConnection(row), targetCount: row.target_count })) });
});

router.post('/connections', asyncRoute(async (req, res) => {
  const body = z.object({
    name: label,
    provider: z.enum(['mega', 's3', 'external', 'drive', 'dropbox', 'onedrive']),
    remoteName: z.string().trim().max(63).optional(),
    credentials: z.record(z.string(), z.string().max(2048)).default({}),
    settings: z.record(z.string(), z.unknown()).default({}),
  }).parse(req.body);
  if (['drive', 'dropbox', 'onedrive'].includes(body.provider))
    throw Object.assign(new Error('Use the OAuth connection flow for this provider'), { status: 409, code: 'OAUTH_REQUIRED' });
  const remoteName = body.remoteName ? assertRemoteName(body.remoteName) : `bmg_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const id = randomUUID();
  const now = new Date().toISOString();
  let authType: 'external' | 'managed_credentials' = 'managed_credentials';
  let managed = 1;
  let secret: { type: string; fields: Record<string, string> } | undefined;
  let safeSettings: Record<string, unknown> = {};
  if (body.provider === 'external') {
    if (!body.remoteName) throw Object.assign(new Error('An existing rclone remote name is required'), { status: 400 });
    authType = 'external';
    managed = 0;
  } else if (body.provider === 'mega') {
    const credentials = z.object({
      username: z.string().trim().email().max(254),
      password: z.string().min(1).max(256),
    }).parse(body.credentials);
    secret = { type: 'mega', fields: { user: credentials.username, pass: await obscureRcloneSecret(credentials.password) } };
  } else {
    const credentials = z.object({
      accessKeyId: z.string().min(1).max(512),
      secretAccessKey: z.string().min(1).max(1024),
      endpoint: z.string().url().max(2048).optional(),
      region: z.string().trim().max(100).optional(),
      provider: z.string().trim().min(1).max(100).default('Other'),
    }).parse(body.credentials);
    const endpoint = credentials.endpoint ? await validateCloudEndpoint(credentials.endpoint) : undefined;
    secret = { type: 's3', fields: {
      provider: credentials.provider,
      env_auth: 'false',
      access_key_id: credentials.accessKeyId,
      secret_access_key: credentials.secretAccessKey,
      ...(endpoint ? { endpoint } : {}),
      ...(credentials.region ? { region: credentials.region } : {}),
    } };
    safeSettings = { endpoint, region: credentials.region, provider: credentials.provider };
  }
  try {
    db.prepare(`INSERT INTO cloud_connections(id,name,provider,remote_name,auth_type,status,managed,config_json,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?,?,?)`).run(id, body.name, body.provider, remoteName, authType, managed, JSON.stringify(safeSettings), now, now);
    if (secret) await putSecret('connection', id, 'rclone-config', secret);
  } catch (error: any) {
    deleteSecrets('connection', id);
    db.prepare('DELETE FROM cloud_connections WHERE id=?').run(id);
    if (String(error?.code).includes('SQLITE_CONSTRAINT'))
      throw Object.assign(new Error('That rclone remote name is already in use'), { status: 409 });
    throw error;
  }
  audit('cloud.connection_created', req, { provider: body.provider, managed: Boolean(managed) }, 'cloud_connection', id);
  res.status(201).json(publicConnection(getConnection(id)));
}));

router.post('/connections/:id/test', asyncRoute(async (req, res) => {
  const connection = getConnection(identifier.parse(req.params.id));
  const testedAt = new Date().toISOString();
  try {
    await testCloudConnection(connection);
    db.prepare("UPDATE cloud_connections SET status='connected',last_tested_at=?,last_error=NULL,updated_at=? WHERE id=?")
      .run(testedAt, testedAt, connection.id);
    audit('cloud.connection_test_succeeded', req, {}, 'cloud_connection', connection.id);
    res.json({ ok: true, status: 'connected', testedAt });
  } catch (error: any) {
    const detail = String(error?.message || 'Connection test failed').slice(0, 1000);
    db.prepare("UPDATE cloud_connections SET status='error',last_tested_at=?,last_error=?,updated_at=? WHERE id=?")
      .run(testedAt, detail, testedAt, connection.id);
    audit('cloud.connection_test_failed', req, { error: detail }, 'cloud_connection', connection.id);
    throw Object.assign(new Error('Unable to access the cloud connection'), { status: 422, code: 'CONNECTION_TEST_FAILED' });
  }
}));

router.get('/connections/:id/browse', asyncRoute(async (req, res) => {
  const connection = getConnection(identifier.parse(req.params.id));
  const folder = z.string().max(1024).default('').parse(req.query.path);
  res.json({ path: normalizeRemoteSubpath(folder), items: await browseRemote(connection, folder) });
}));

router.delete('/connections/:id', (req, res) => {
  const connectionId = identifier.parse(req.params.id);
  getConnection(connectionId);
  if (db.prepare('SELECT 1 FROM storage_targets WHERE connection_id=? LIMIT 1').get(connectionId))
    throw Object.assign(new Error('Remove this connection\'s storage targets first'), { status: 409 });
  db.transaction(() => {
    deleteSecrets('connection', connectionId);
    db.prepare('DELETE FROM cloud_connections WHERE id=?').run(connectionId);
  })();
  audit('cloud.connection_deleted', req, {}, 'cloud_connection', connectionId);
  res.json({ ok: true });
});

router.get('/targets', (_req, res) => {
  const rows = db.prepare(`SELECT t.*,c.name connection_name,c.provider,c.status connection_status,
    (SELECT COUNT(*) FROM target_assignments a WHERE a.target_id=t.id AND a.enabled=1) assignment_count
    FROM storage_targets t LEFT JOIN cloud_connections c ON c.id=t.connection_id ORDER BY t.kind,t.name COLLATE NOCASE`).all() as any[];
  res.json({ items: rows.map(row => ({
    id: row.id, connectionId: row.connection_id, kind: row.kind, name: row.name, rootPath: row.root_path,
    encryptionMode: row.encryption_mode, enabled: Boolean(row.enabled), connectionName: row.connection_name,
    provider: row.provider, connectionStatus: row.connection_status, assignmentCount: row.assignment_count,
  })) });
});

router.post('/targets', asyncRoute(async (req, res) => {
  const body = z.object({
    connectionId: identifier,
    name: label,
    rootPath: z.string().max(1024),
    encryptionMode: z.enum(['none', 'crypt']).default('crypt'),
  }).parse(req.body);
  const connection = getConnection(body.connectionId);
  if (connection.status !== 'connected') throw Object.assign(new Error('Test the connection before creating a target'), { status: 409 });
  const id = randomUUID();
  const now = new Date().toISOString();
  const rootPath = normalizeRemoteSubpath(body.rootPath);
  let cryptSecret: { password: string; password2: string } | undefined;
  if (body.encryptionMode === 'crypt') {
    cryptSecret = {
      password: await obscureRcloneSecret(randomBytes(32).toString('base64url')),
      password2: await obscureRcloneSecret(randomBytes(32).toString('base64url')),
    };
  }
  try {
    db.prepare(`INSERT INTO storage_targets(id,connection_id,kind,name,root_path,encryption_mode,enabled,config_json,created_at,updated_at)
      VALUES(?,?,'rclone',?,?,?,1,'{}',?,?)`).run(id, connection.id, body.name, rootPath, body.encryptionMode, now, now);
    if (cryptSecret) await putSecret('target', id, 'crypt', cryptSecret);
  } catch (error) {
    deleteSecrets('target', id);
    db.prepare("DELETE FROM storage_targets WHERE id=? AND kind='rclone'").run(id);
    throw error;
  }
  audit('cloud.target_created', req, { encryptionMode: body.encryptionMode }, 'storage_target', id);
  res.status(201).json({ id, connectionId: connection.id, name: body.name, rootPath, encryptionMode: body.encryptionMode });
}));

router.delete('/targets/:id', (req, res) => {
  const targetId = identifier.parse(req.params.id);
  const target = db.prepare("SELECT * FROM storage_targets WHERE id=? AND kind='rclone'").get(targetId);
  if (!target) throw Object.assign(new Error('Storage target not found'), { status: 404 });
  if (db.prepare("SELECT 1 FROM backup_replicas WHERE target_id=? AND status!='deleted' LIMIT 1").get(targetId))
    throw Object.assign(new Error('This target still contains tracked replicas'), { status: 409 });
  db.transaction(() => {
    deleteSecrets('target', targetId);
    db.prepare('DELETE FROM storage_targets WHERE id=?').run(targetId);
  })();
  audit('cloud.target_deleted', req, {}, 'storage_target', targetId);
  res.json({ ok: true });
});

router.get('/assignments/global', (_req, res) => {
  const selected = db.prepare("SELECT target_id FROM target_assignments WHERE scope_type='global' AND scope_key='global' AND enabled=1").all() as Array<{ target_id: string }>;
  res.json({ targetIds: selected.map(row => row.target_id) });
});

router.put('/assignments/global', (req, res) => {
  const targetIds = z.array(identifier).max(20).transform(items => [...new Set(items)]).parse(req.body?.targetIds);
  if (targetIds.length) {
    const placeholders = targetIds.map(() => '?').join(',');
    const valid = db.prepare(`SELECT COUNT(*) count FROM storage_targets WHERE kind='rclone' AND enabled=1 AND id IN (${placeholders})`).get(...targetIds) as { count: number };
    if (valid.count !== targetIds.length) throw Object.assign(new Error('One or more storage targets are unavailable'), { status: 400 });
  }
  const now = new Date().toISOString();
  const retention = JSON.stringify(getSettings().defaultRetention);
  db.transaction(() => {
    db.prepare("DELETE FROM target_assignments WHERE scope_type='global' AND scope_key='global'").run();
    const insert = db.prepare(`INSERT INTO target_assignments(id,target_id,scope_type,scope_key,required,enabled,retention_json,created_at,updated_at)
      VALUES(?,?,'global','global',1,1,?,?,?)`);
    for (const targetId of targetIds) insert.run(randomUUID(), targetId, retention, now, now);
  })();
  audit('cloud.assignments_updated', req, { scope: 'global', targetCount: targetIds.length }, 'target_assignment', 'global');
  res.json({ targetIds });
});

export default router;
