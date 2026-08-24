import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ManagedRcloneConfig } from './rclone-config.js';

export type OAuthProvider = 'drive' | 'dropbox' | 'onedrive';

const definitions: Record<OAuthProvider, {
  authorize: string;
  token: string;
  scope?: string;
}> = {
  drive: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive',
  },
  dropbox: {
    authorize: 'https://www.dropbox.com/oauth2/authorize',
    token: 'https://api.dropboxapi.com/oauth2/token',
  },
  onedrive: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access https://graph.microsoft.com/Files.ReadWrite.All',
  },
};

export function oauthRandomValue(): string {
  return randomBytes(32).toString('base64url');
}

export function oauthSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function buildAuthorizationUrl(input: {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const definition = definitions[input.provider];
  const url = new URL(definition.authorize);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (definition.scope) url.searchParams.set('scope', definition.scope);
  if (input.provider === 'drive') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  if (input.provider === 'dropbox') tokenAccessType(url);
  return url.toString();
}

function tokenAccessType(url: URL): void {
  url.searchParams.set('token_access_type', 'offline');
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().min(1).max(100).default('Bearer'),
  refresh_token: z.string().min(1).max(8192),
  expires_in: z.coerce.number().int().positive().max(31_536_000).default(3600),
});

async function jsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 128 * 1024) throw new Error('OAuth provider response was too large');
  if (!response.ok) throw Object.assign(new Error('The OAuth provider rejected the authorization request'), { code: 'OAUTH_EXCHANGE_FAILED' });
  try { return JSON.parse(text); }
  catch { throw new Error('The OAuth provider returned an invalid response'); }
}

export async function exchangeAuthorizationCode(input: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ManagedRcloneConfig> {
  const definition = definitions[input.provider];
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  });
  const response = await fetch(definition.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const token = tokenSchema.parse(await jsonResponse(response));
  const rcloneToken = JSON.stringify({
    access_token: token.access_token,
    token_type: token.token_type,
    refresh_token: token.refresh_token,
    expiry: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  });
  const fields: Record<string, string> = {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    token: rcloneToken,
  };
  if (input.provider === 'drive') fields.scope = 'drive';
  if (input.provider === 'onedrive') {
    const driveResponse = await fetch('https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType', {
      headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const drive = z.object({
      id: z.string().min(1).max(2048),
      driveType: z.enum(['personal', 'business', 'documentLibrary']),
    }).parse(await jsonResponse(driveResponse));
    fields.drive_id = drive.id;
    fields.drive_type = drive.driveType;
    fields.region = 'global';
  }
  return {
    type: input.provider === 'drive' ? 'drive' : input.provider,
    fields,
  };
}
