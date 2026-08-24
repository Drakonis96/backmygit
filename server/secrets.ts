import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { openPayload, sealPayload } from './secret-crypto.js';

export { openPayload, sealPayload } from './secret-crypto.js';

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64url');
  if (key.length !== 32) throw new Error('The BackMyGit master key must contain exactly 32 base64url-encoded bytes');
  return key;
}

export async function ensureMasterKey(): Promise<void> {
  try {
    const stat = await fs.lstat(config.masterKeyFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The master key must be a regular file');
    if ((stat.mode & 0o077) !== 0) throw new Error('The master key must not be accessible by group or other users');
    decodeKey(await fs.readFile(config.masterKeyFile, 'utf8'));
    return;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (config.masterKeyExternal)
    throw new Error(`MASTER_KEY_FILE does not exist: ${config.masterKeyFile}`);
  await fs.mkdir(path.dirname(config.masterKeyFile), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(config.masterKeyFile, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await fs.chmod(config.masterKeyFile, 0o600);
  decodeKey(await fs.readFile(config.masterKeyFile, 'utf8'));
}

async function masterKey(): Promise<Buffer> {
  await ensureMasterKey();
  return decodeKey(await fs.readFile(config.masterKeyFile, 'utf8'));
}

function context(ownerType: string, ownerId: string, purpose: string): string {
  return `backmygit:${ownerType}:${ownerId}:${purpose}`;
}

type SecretOwner = 'connection' | 'target' | 'oauth_state' | 'recovery';

export async function putSecret(ownerType: SecretOwner, ownerId: string, purpose: string, value: unknown): Promise<void> {
  const now = new Date().toISOString();
  const ciphertext = sealPayload(await masterKey(), context(ownerType, ownerId, purpose), value);
  db.prepare(`INSERT INTO encrypted_secrets(id,owner_type,owner_id,purpose,ciphertext,key_version,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(owner_type,owner_id,purpose) DO UPDATE SET
      ciphertext=excluded.ciphertext,key_version=excluded.key_version,updated_at=excluded.updated_at`).run(
        randomUUID(), ownerType, ownerId, purpose, ciphertext, now, now,
      );
}

export async function getSecret<T>(ownerType: SecretOwner, ownerId: string, purpose: string): Promise<T | undefined> {
  const row = db.prepare(`SELECT ciphertext FROM encrypted_secrets
    WHERE owner_type=? AND owner_id=? AND purpose=?`).get(ownerType, ownerId, purpose) as { ciphertext: string } | undefined;
  if (!row) return undefined;
  return openPayload<T>(await masterKey(), context(ownerType, ownerId, purpose), row.ciphertext);
}

export function deleteSecrets(ownerType: SecretOwner, ownerId: string): void {
  db.prepare('DELETE FROM encrypted_secrets WHERE owner_type=? AND owner_id=?').run(ownerType, ownerId);
}

export function deleteSecret(ownerType: SecretOwner, ownerId: string, purpose: string): void {
  db.prepare('DELETE FROM encrypted_secrets WHERE owner_type=? AND owner_id=? AND purpose=?')
    .run(ownerType, ownerId, purpose);
}
