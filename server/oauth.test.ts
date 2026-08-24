import { describe, expect, it } from 'vitest';
import { buildAuthorizationUrl, oauthRandomValue, oauthSha256 } from './oauth.js';

describe('managed OAuth authorization', () => {
  it.each([
    ['drive', 'https://accounts.google.com'],
    ['dropbox', 'https://www.dropbox.com'],
    ['onedrive', 'https://login.microsoftonline.com'],
  ] as const)('builds a fixed-provider PKCE URL for %s', (provider, origin) => {
    const url = new URL(buildAuthorizationUrl({
      provider,
      clientId: 'client-id',
      redirectUri: 'https://backup.example/api/cloud/oauth/callback',
      state: 'state-value',
      codeChallenge: 'challenge-value',
    }));
    expect(url.origin).toBe(origin);
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_secret')).toBeNull();
  });

  it('generates high-entropy values and deterministic non-plaintext hashes', () => {
    const value = oauthRandomValue();
    expect(value.length).toBeGreaterThanOrEqual(40);
    expect(oauthSha256(value)).not.toBe(value);
    expect(oauthSha256(value)).toBe(oauthSha256(value));
  });
});
