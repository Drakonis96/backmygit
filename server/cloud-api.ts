import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from './auth.js';
import { browseRemote, cloudProviders, getConnection, testCloudConnection, validateCloudEndpoint } from './cloud.js';
import { db, getSettings } from './db.js';
import { config } from './config.js';
import { buildAuthorizationUrl, exchangeAuthorizationCode, oauthRandomValue, oauthSha256, type OAuthProvider } from './oauth.js';
import { assertRemoteName, obscureRcloneSecret } from './rclone.js';
import { normalizeRemoteSubpath } from './rclone-config.js';
import { deleteSecret, deleteSecrets, getSecret, putSecret } from './secrets.js';
import { retryTransfer } from './transfer-queue.js';

const router = Router();
const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => void fn(req, res, next).catch(next);
const identifier = z.string().uuid();
const label = z.string().trim().min(1).max(100);
const oauthProvider = z.enum(['drive', 'dropbox', 'onedrive']);

function oauthRedirectUri(): string {
  if (!config.publicUrl)
    throw Object.assign(new Error('PUBLIC_URL is required for managed OAuth connections'), { status: 503, code: 'OAUTH_NOT_CONFIGURED' });
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(config.publicUrl.hostname);
  if (config.publicUrl.protocol !== 'https:' && !loopback)
    throw Object.assign(new Error('Managed OAuth requires an HTTPS PUBLIC_URL'), { status: 503, code: 'OAUTH_HTTPS_REQUIRED' });
  return new URL('/api/cloud/oauth/callback', config.publicUrl).toString();
}

function oauthResultUrl(result: 'success' | 'error'): string {
  return new URL(`/destinations?oauth=${result}`, config.publicUrl!).toString();
}

function clearExpiredOAuthFlows(): void {
  const rows = db.prepare('SELECT id FROM oauth_flows WHERE expires_at<=?').all(new Date().toISOString()) as Array<{ id: string }>;
  for (const row of rows) deleteSecrets('oauth_state', row.id);
  db.prepare('DELETE FROM oauth_flows WHERE expires_at<=?').run(new Date().toISOString());
}

async function createOAuthFlow(req: Request, input: {
  connectionId: string;
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  if (!req.user || !req.sessionId) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const redirectUri = oauthRedirectUri();
  clearExpiredOAuthFlows();
  const previous = db.prepare('SELECT id FROM oauth_flows WHERE connection_id=? AND used_at IS NULL').all(input.connectionId) as Array<{ id: string }>;
  for (const flow of previous) deleteSecrets('oauth_state', flow.id);
  db.prepare('DELETE FROM oauth_flows WHERE connection_id=? AND used_at IS NULL').run(input.connectionId);
  const id = randomUUID();
  const state = oauthRandomValue();
  const verifier = oauthRandomValue();
  const now = new Date();
  try {
    await putSecret('oauth_state', id, 'pkce', { verifier });
    await putSecret('connection', input.connectionId, 'oauth-client', {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    db.prepare(`INSERT INTO oauth_flows(id,connection_id,user_id,session_id,state_hash,provider,redirect_uri,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
        id, input.connectionId, req.user.id, req.sessionId, oauthSha256(state), input.provider, redirectUri,
        new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString(),
      );
  } catch (error) {
    deleteSecrets('oauth_state', id);
    throw error;
  }
  return buildAuthorizationUrl({
    provider: input.provider,
    clientId: input.clientId,
    redirectUri,
    state,
    codeChallenge: oauthSha256(verifier),
  });
}

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

router.get('/oauth/config', (_req, res) => {
  let redirectUri: string | undefined;
  try { redirectUri = oauthRedirectUri(); } catch { /* reported as unavailable */ }
  res.json({ available: Boolean(redirectUri), redirectUri });
});

router.post('/oauth/start', asyncRoute(async (req, res) => {
  const body = z.object({
    name: label,
    provider: oauthProvider,
    clientId: z.string().trim().min(1).max(2048),
    clientSecret: z.string().min(1).max(8192),
  }).parse(req.body);
  const id = randomUUID();
  const remoteName = `bmg_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cloud_connections(id,name,provider,remote_name,auth_type,status,managed,config_json,created_at,updated_at)
    VALUES(?,?,?,?,'managed_oauth','pending',1,'{}',?,?)`).run(id, body.name, body.provider, remoteName, now, now);
  try {
    const authorizationUrl = await createOAuthFlow(req, {
      connectionId: id, provider: body.provider, clientId: body.clientId, clientSecret: body.clientSecret,
    });
    audit('cloud.oauth_started', req, { provider: body.provider }, 'cloud_connection', id);
    res.status(201).json({ authorizationUrl, connection: publicConnection(getConnection(id)) });
  } catch (error) {
    deleteSecrets('connection', id);
    db.prepare('DELETE FROM cloud_connections WHERE id=?').run(id);
    throw error;
  }
}));

router.post('/connections/:id/oauth/start', asyncRoute(async (req, res) => {
  const connection = getConnection(identifier.parse(req.params.id));
  const provider = oauthProvider.parse(connection.provider);
  if (connection.auth_type !== 'managed_oauth')
    throw Object.assign(new Error('This connection does not use managed OAuth'), { status: 409 });
  const finalConfig = await getSecret<{ fields: Record<string, string> }>('connection', connection.id, 'rclone-config');
  const pending = await getSecret<{ clientId: string; clientSecret: string }>('connection', connection.id, 'oauth-client');
  const clientId = finalConfig?.fields?.client_id || pending?.clientId;
  const clientSecret = finalConfig?.fields?.client_secret || pending?.clientSecret;
  if (!clientId || !clientSecret) throw Object.assign(new Error('OAuth client credentials are unavailable'), { status: 409 });
  const authorizationUrl = await createOAuthFlow(req, { connectionId: connection.id, provider, clientId, clientSecret });
  db.prepare("UPDATE cloud_connections SET status='pending',last_error=NULL,updated_at=? WHERE id=?")
    .run(new Date().toISOString(), connection.id);
  audit('cloud.oauth_reauthorization_started', req, { provider }, 'cloud_connection', connection.id);
  res.json({ authorizationUrl });
}));

router.get('/oauth/callback', asyncRoute(async (req, res) => {
  if (!req.user || !req.sessionId) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const query = z.object({
    state: z.string().min(20).max(512),
    code: z.string().min(1).max(8192).optional(),
    error: z.string().max(200).optional(),
  }).parse(req.query);
  const now = new Date().toISOString();
  const flow = db.prepare(`SELECT * FROM oauth_flows
    WHERE state_hash=? AND user_id=? AND session_id=? AND used_at IS NULL AND expires_at>?`).get(
      oauthSha256(query.state), req.user.id, req.sessionId, now,
    ) as any;
  if (!flow) throw Object.assign(new Error('The OAuth authorization request is invalid or expired'), { status: 400, code: 'INVALID_OAUTH_STATE' });
  const consumed = db.prepare('UPDATE oauth_flows SET used_at=? WHERE id=? AND used_at IS NULL').run(now, flow.id);
  if (consumed.changes !== 1) throw Object.assign(new Error('The OAuth authorization request was already used'), { status: 409 });
  try {
    if (query.error || !query.code) throw Object.assign(new Error('Authorization was not granted'), { code: 'OAUTH_DENIED' });
    const pkce = await getSecret<{ verifier: string }>('oauth_state', flow.id, 'pkce');
    const client = await getSecret<{ clientId: string; clientSecret: string }>('connection', flow.connection_id, 'oauth-client');
    if (!pkce?.verifier || !client?.clientId || !client.clientSecret) throw new Error('OAuth flow secrets are unavailable');
    const rcloneConfig = await exchangeAuthorizationCode({
      provider: oauthProvider.parse(flow.provider),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code: query.code,
      codeVerifier: pkce.verifier,
      redirectUri: flow.redirect_uri,
    });
    await putSecret('connection', flow.connection_id, 'rclone-config', rcloneConfig);
    deleteSecret('connection', flow.connection_id, 'oauth-client');
    db.prepare("UPDATE cloud_connections SET status='connected',last_error=NULL,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), flow.connection_id);
    audit('cloud.oauth_completed', req, { provider: flow.provider }, 'cloud_connection', flow.connection_id);
    res.redirect(303, oauthResultUrl('success'));
  } catch (error: any) {
    const detail = String(error?.code || 'OAUTH_FAILED').slice(0, 100);
    db.prepare("UPDATE cloud_connections SET status='reauthorization_required',last_error=?,updated_at=? WHERE id=?")
      .run('OAuth authorization failed', new Date().toISOString(), flow.connection_id);
    audit('cloud.oauth_failed', req, { provider: flow.provider, code: detail }, 'cloud_connection', flow.connection_id);
    res.redirect(303, oauthResultUrl('error'));
  } finally {
    deleteSecrets('oauth_state', flow.id);
  }
}));

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
    const flows = db.prepare('SELECT id FROM oauth_flows WHERE connection_id=?').all(connectionId) as Array<{ id: string }>;
    for (const flow of flows) deleteSecrets('oauth_state', flow.id);
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

router.get('/transfers', (req, res) => {
  const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
  const rows = db.prepare(`SELECT j.id,j.operation,j.status,j.attempts,j.next_attempt_at,j.bytes_total,j.bytes_transferred,
    j.speed_bps,j.error_code,j.error,j.created_at,j.started_at,j.completed_at,r.status replica_status,r.location,
    r.snapshot_id,t.id target_id,t.name target_name,t.encryption_mode,c.name connection_name,c.provider,
    repo.owner,repo.name repository,br.name branch,s.commit_sha
    FROM transfer_jobs j JOIN backup_replicas r ON r.id=j.replica_id
    JOIN storage_targets t ON t.id=r.target_id JOIN cloud_connections c ON c.id=t.connection_id
    JOIN snapshots s ON s.id=r.snapshot_id JOIN repositories repo ON repo.id=s.repository_id
    JOIN branches br ON br.id=s.branch_id ORDER BY j.created_at DESC LIMIT ?`).all(limit);
  res.json({ items: rows });
});

router.post('/transfers/:id/retry', (req, res) => {
  const jobId = identifier.parse(req.params.id);
  retryTransfer(jobId);
  audit('cloud.transfer_retried', req, {}, 'transfer_job', jobId);
  res.json({ ok: true });
});

export default router;
