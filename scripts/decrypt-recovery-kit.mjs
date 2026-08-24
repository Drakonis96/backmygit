#!/usr/bin/env node
import { createDecipheriv, scrypt as scryptCallback } from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const [input, output] = process.argv.slice(2);
const passphrase = process.env.BACKMYGIT_RECOVERY_PASSPHRASE;
if (!input || !output || !passphrase) {
  console.error('Usage: BACKMYGIT_RECOVERY_PASSPHRASE="..." node scripts/decrypt-recovery-kit.mjs KIT.json OUTPUT.json');
  process.exit(2);
}
const envelope = JSON.parse(await fs.readFile(input, 'utf8'));
if (envelope.schemaVersion !== 1 || envelope.kdf !== 'scrypt' || envelope.cipher !== 'aes-256-gcm')
  throw new Error('Unsupported recovery kit format');
const salt = Buffer.from(envelope.salt, 'base64url');
const iv = Buffer.from(envelope.iv, 'base64url');
const tag = Buffer.from(envelope.tag, 'base64url');
if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid recovery kit envelope');
const key = Buffer.from(await promisify(scryptCallback)(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
const decipher = createDecipheriv('aes-256-gcm', key, iv);
decipher.setAAD(Buffer.from('backmygit-recovery-kit:v1'));
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
await fs.writeFile(output, `${JSON.stringify(JSON.parse(plaintext.toString('utf8')), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Decrypted recovery material written with mode 0600 to ${output}`);
