import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openPayload, sealPayload } from './secret-crypto.js';

describe('encrypted secret payloads', () => {
  it('round-trips structured values without exposing plaintext', () => {
    const key = randomBytes(32);
    const value = { token: 'highly-sensitive-token', nested: { expires: 123 } };
    const sealed = sealPayload(key, 'connection:one', value);
    expect(sealed).not.toContain(value.token);
    expect(openPayload(key, 'connection:one', sealed)).toEqual(value);
  });

  it('authenticates both ciphertext and ownership context', () => {
    const key = randomBytes(32);
    const sealed = sealPayload(key, 'connection:one', { password: 'secret' });
    expect(() => openPayload(key, 'connection:two', sealed)).toThrow();
    const changed = `${sealed.slice(0, -1)}${sealed.endsWith('A') ? 'B' : 'A'}`;
    expect(() => openPayload(key, 'connection:one', changed)).toThrow();
  });
});
