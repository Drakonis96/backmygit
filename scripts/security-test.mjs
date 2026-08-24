import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import Database from 'better-sqlite3';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backmygit-security-'));
const dataDir = path.join(root, 'data');
const backupRoot = path.join(root, 'backups');
await fs.mkdir(dataDir); await fs.mkdir(backupRoot);
const port = 18_000 + Math.floor(Math.random() * 10_000);
const host = `127.0.0.1:${port}`;
const base = `http://${host}`;
const child = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production', PORT: String(port), DATA_DIR: dataDir, BACKUP_ROOT: backupRoot,
    BACKUP_HOST_PATH: backupRoot, PUBLIC_URL: `https://${host}`, TRUSTED_PROXIES: 'loopback', FORCE_HTTPS: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const stop = async () => {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  await fs.rm(root, { recursive: true, force: true });
};
process.on('SIGINT', () => void stop().finally(() => process.exit(130)));
const assert = (condition, message) => { if (!condition) throw new Error(message); console.log(`✓ ${message}`); };
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/api/health`, { redirect: 'manual', headers: { Host: host, 'X-Forwarded-Proto': 'https' } });
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start:\n${logs}`);
}
const headers = (extra = {}) => ({ Host: host, 'X-Forwarded-Proto': 'https', ...extra });
try {
  await waitForServer();
  const csp = await fetch(`${base}/api/health`, { headers: headers() });
  assert(csp.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'CSP prevents framing');

  const redirect = await fetch(`${base}/api/health`, { redirect: 'manual', headers: { Host: host } });
  assert(redirect.status === 308 && redirect.headers.get('location') === `https://${host}/api/health`, 'HTTP GET is redirected to the configured HTTPS origin');

  const badHost = await fetch(`http://localhost:${port}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert(badHost.status === 400, 'unrecognized Host headers are rejected');

  const beforeSetup = await fetch(`${base}/api/settings`, { headers: headers() });
  assert(beforeSetup.status === 503, 'application API is locked before initial setup');
  const status = await (await fetch(`${base}/api/auth/setup-status`, { headers: headers() })).json();
  assert(status.required === true, 'setup status reports a fresh installation');

  const token = (await fs.readFile(path.join(dataDir, 'bootstrap-token'), 'utf8')).trim();
  const crossSite = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' }),
    body: JSON.stringify({ token, username: 'admin', password: 'correct horse battery staple' }),
  });
  assert(crossSite.status === 403, 'cross-origin setup requests are blocked');

  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json', Origin: `https://${host}` }),
    body: JSON.stringify({ token, username: 'admin', password: 'correct horse battery staple' }),
  });
  const session = await setup.json();
  const setCookie = setup.headers.get('set-cookie') || '';
  assert(setup.status === 201 && session.user.role === 'admin', 'one-time bootstrap creates the administrator');
  assert(setCookie.includes('__Host-backmygit_session=') && setCookie.includes('HttpOnly') && setCookie.includes('Secure') && setCookie.includes('SameSite=Lax'), 'session cookie uses secure host-only attributes');
  await fs.access(path.join(dataDir, 'bootstrap-token')).then(() => { throw new Error('bootstrap token remains'); }, () => undefined);
  assert(true, 'bootstrap token is removed after setup');
  const cookie = setCookie.split(';', 1)[0];

  const replay = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json', Origin: `https://${host}` }),
    body: JSON.stringify({ token, username: 'second-admin', password: 'another secure password 2026' }),
  });
  assert(replay.status === 409, 'bootstrap cannot be replayed');

  const anonymous = await fetch(`${base}/api/settings`, { headers: headers() });
  assert(anonymous.status === 401, 'protected API rejects anonymous access');
  const authenticated = await fetch(`${base}/api/settings`, { headers: headers({ Cookie: cookie }) });
  assert(authenticated.status === 200, 'authenticated session can read the API');

  const noCsrf = await fetch(`${base}/api/storage/retention`, {
    method: 'POST', headers: headers({ Cookie: cookie, 'Content-Type': 'application/json', Origin: `https://${host}` }), body: '{}',
  });
  assert(noCsrf.status === 403, 'state-changing requests require a CSRF token');
  const withCsrf = await fetch(`${base}/api/storage/retention`, {
    method: 'POST', headers: headers({ Cookie: cookie, 'Content-Type': 'application/json', Origin: `https://${host}`, 'X-CSRF-Token': session.csrfToken }), body: '{}',
  });
  assert(withCsrf.status === 200, 'valid same-origin CSRF-protected mutation succeeds');

  const database = new Database(path.join(dataDir, 'backmygit.sqlite'));
  const now = new Date().toISOString();
  const rolePassword = 'role security test password';
  const roleHash = await argon2.hash(rolePassword);
  database.prepare(`INSERT INTO users(username,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?)`)
    .run('viewer', roleHash, 'viewer', now, now);
  database.prepare(`INSERT INTO users(username,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?)`)
    .run('operator', roleHash, 'operator', now, now);
  database.close();
  const loginAs = async (username) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json', Origin: `https://${host}` }),
      body: JSON.stringify({ username, password: rolePassword }),
    });
    return { response, body: await response.json(), cookie: (response.headers.get('set-cookie') || '').split(';', 1)[0] };
  };
  const viewer = await loginAs('viewer');
  const viewerRead = await fetch(`${base}/api/settings`, { headers: headers({ Cookie: viewer.cookie }) });
  const viewerStorage = await (await fetch(`${base}/api/storage`, { headers: headers({ Cookie: viewer.cookie }) })).json();
  const viewerWrite = await fetch(`${base}/api/storage/reconcile`, {
    method: 'POST', headers: headers({ Cookie: viewer.cookie, 'Content-Type': 'application/json', Origin: `https://${host}`, 'X-CSRF-Token': viewer.body.csrfToken }), body: '{}',
  });
  assert(viewerRead.status === 200 && viewerWrite.status === 403, 'viewer role is read-only');
  assert(!('root' in viewerStorage) && !('hostPath' in viewerStorage), 'viewer responses do not expose host filesystem paths');
  const operator = await loginAs('operator');
  const operatorAllowed = await fetch(`${base}/api/storage/reconcile`, {
    method: 'POST', headers: headers({ Cookie: operator.cookie, 'Content-Type': 'application/json', Origin: `https://${host}`, 'X-CSRF-Token': operator.body.csrfToken }), body: '{}',
  });
  const operatorDenied = await fetch(`${base}/api/history`, {
    method: 'DELETE', headers: headers({ Cookie: operator.cookie, 'Content-Type': 'application/json', Origin: `https://${host}`, 'X-CSRF-Token': operator.body.csrfToken }), body: '{}',
  });
  assert(operatorAllowed.status === 200 && operatorDenied.status === 403, 'operator role is limited to operational mutations');

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST', headers: headers({ Cookie: cookie, 'Content-Type': 'application/json', Origin: `https://${host}`, 'X-CSRF-Token': session.csrfToken }), body: '{}',
  });
  assert(logout.status === 200, 'logout revokes the current session');
  const afterLogout = await fetch(`${base}/api/settings`, { headers: headers({ Cookie: cookie }) });
  assert(afterLogout.status === 401, 'revoked session cannot be reused');
} finally {
  await stop();
}
