import { describe, expect, it } from 'vitest';
import { openRecoveryKit, sealRecoveryKit } from './recovery-kit.js';

describe('recovery kit encryption', () => {
  it('round-trips secrets without exposing them in the envelope', async () => {
    const envelope = await sealRecoveryKit('correct horse battery staple', { token: 'very-secret-token' });
    expect(JSON.stringify(envelope)).not.toContain('very-secret-token');
    await expect(openRecoveryKit('correct horse battery staple', envelope)).resolves.toEqual({ token: 'very-secret-token' });
    await expect(openRecoveryKit('incorrect password', envelope)).rejects.toThrow();
  });
});
