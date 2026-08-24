import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export function sealPayload(key: Buffer, context: string, value: unknown): string {
  if (key.length !== 32) throw new Error('Invalid encryption key length');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function openPayload<T>(key: Buffer, context: string, sealed: string): T {
  if (key.length !== 32) throw new Error('Invalid encryption key length');
  const [version, nonce, tag, ciphertext, extra] = sealed.split('.');
  if (version !== VERSION || !nonce || !tag || !ciphertext || extra) throw new Error('Unsupported encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')) as T;
}
