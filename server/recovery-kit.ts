import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { z } from 'zod';

const aad = Buffer.from('backmygit-recovery-kit:v1');

export interface RecoveryKitEnvelope {
  schemaVersion: 1;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

async function key(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(
    passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, derived) => error ? reject(error) : resolve(Buffer.from(derived)),
  ));
}

export async function sealRecoveryKit(passphrase: string, payload: unknown): Promise<RecoveryKitEnvelope> {
  if (passphrase.length < 12 || passphrase.length > 1024) throw new Error('Recovery passphrase must contain 12 to 1024 characters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await key(passphrase, salt), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    schemaVersion: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export async function openRecoveryKit(passphrase: string, input: unknown): Promise<unknown> {
  const envelope = z.object({
    schemaVersion: z.literal(1), kdf: z.literal('scrypt'), cipher: z.literal('aes-256-gcm'),
    salt: z.string().max(100), iv: z.string().max(100), tag: z.string().max(100), ciphertext: z.string().max(100_000_000),
  }).parse(input);
  const salt = Buffer.from(envelope.salt, 'base64url');
  const iv = Buffer.from(envelope.iv, 'base64url');
  const tag = Buffer.from(envelope.tag, 'base64url');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid recovery kit envelope');
  const decipher = createDecipheriv('aes-256-gcm', await key(passphrase, salt), iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8'));
}
