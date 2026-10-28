// OAuth 2.1 for assistants (MCP clients) acting for the owner: the authorization server, and the check /api/mcp makes.
// It is one more way an owner's device signs in; nothing in it is protocol.
//
// - Metadata (RFC 8414, RFC 9728) and documents validated with the MCP SDK's schemas.
// - The issuer and every URL in the documents come from WEBAUTHN_ORIGIN, never from a request's Host header
//   (instrumentation.ts refuses to start without it).
// - Dynamic client registration (RFC 7591): public clients only (no secrets, token_endpoint_auth_method none);
//   redirect URIs https, or http on a loopback address (RFC 8252, any port); no fragments. Only the client's name,
//   redirect URIs and auth method are stored; a client that never got a device is deleted after 7 days.
// - Authorization code with PKCE (S256 only), 10-minute single-use codes stored hashed, expired ones swept. Every fault
//   found before the owner consents is a 400 page on the head; only the answer after consent goes back to the client
//   (a code, or access_denied). A code presented twice signs out the device its first exchange made (RFC 6749
//   §4.1.2). The owner consents on /oauth/consent, signed in with a passkey; the request reaches that page signed by
//   the head, and the page shows only what the head verified.
// - Tokens: an access token is a Session JWT (15 minutes) with scope `owner` and the MCP URL as its resource (RFC
//   8707). A scoped token reaches only /api/mcp and the /api/me routes its tools call (lib/auth/session.ts): never
//   settings, devices, enrolment, sign-in, consent or minting. The refresh token (90 days) is a device's, platform
//   `mcp`, a family rotated on every use, any earlier generation presented again signing the device out. Revoking is
//   signing the device out in Settings.

import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import {
  OAuthClientMetadataSchema, OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthTokensSchema,
  type OAuthClientInformationFull, type OAuthMetadata, type OAuthProtectedResourceMetadata, type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { and, eq, isNull, lt, notExists, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { devices, oauthClients, oauthCodes } from '../db/schema';
import {
  ACCESS_TTL_SECONDS, hash, MCP_PLATFORM, newRefreshFamily, REFRESH_TTL_SECONDS, rotateRefresh, sign, verify, type Session,
} from './auth/session';
import { now } from './clock';

export const SCOPE = 'owner';
export const CODE_TTL_SECONDS = 10 * 60;
const REQUEST_AUDIENCE = 'oauth-request';
const CLIENT_NAME_MAX = 100;
const REDIRECT_URIS_MAX = 10;

const UNUSED_CLIENT_DAYS = 7;

/**
 * The authorization server's origin and issuer: WEBAUTHN_ORIGIN, the head's one public origin. Never a request's Host
 * header, which a client could choose. instrumentation.ts refuses to start without it, so this never falls back.
 */
export function oauthOrigin(): string {
  const configured = process.env.WEBAUTHN_ORIGIN;
  if (!configured) throw new Error('WEBAUTHN_ORIGIN is not set: OAuth (and passkeys) need the head’s public origin (docs/deploy.md)');
  return new URL(configured).origin;
}

export const mcpUrl = (origin: string) => `${origin}/api/mcp`;
export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;

/** An OAuth error (RFC 6749 §5.2, RFC 7591 §3.2.2): a code, a sentence, and the HTTP status. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
  json(): Response {
    return Response.json({ error: this.error, error_description: this.description }, { status: this.status, headers: NO_STORE });
  }
}

export const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

// --- metadata ----------------------------------------------------------------------------------------------

export function authorizationServerMetadata(origin: string): OAuthMetadata {
  return OAuthMetadataSchema.parse({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: `${origin}/connect`,
  });
}

export function protectedResourceMetadata(origin: string): OAuthProtectedResourceMetadata {
  return OAuthProtectedResourceMetadataSchema.parse({
    resource: mcpUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Brief: the owner’s cards and decisions',
    resource_documentation: `${origin}/connect`,
  });
}

// --- registration (RFC 7591) ---------------------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** https anywhere, or http on a loopback address for a native app (RFC 8252 §7.3); never a fragment. */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash !== '' || uri.includes('#')) return false;
  if (u.username || u.password) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
}

export async function registerClient(db: Db, body: unknown): Promise<OAuthClientInformationFull> {
  const parsed = OAuthClientMetadataSchema.safeParse(body);
  if (!parsed.success) throw new OAuthError('invalid_client_metadata', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const m = parsed.data;
  if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'only public clients are registered here: token_endpoint_auth_method must be none (PKCE stands in for a secret)');
  }
  if (m.redirect_uris.length === 0 || m.redirect_uris.length > REDIRECT_URIS_MAX) throw new OAuthError('invalid_redirect_uri', `1 to ${REDIRECT_URIS_MAX} redirect_uris`);
  const bad = m.redirect_uris.find((u) => !redirectUriAllowed(u));
  if (bad) throw new OAuthError('invalid_redirect_uri', `${bad}: a redirect URI is https, or http on a loopback address, with no fragment`);
  const grants = m.grant_types ?? ['authorization_code', 'refresh_token'];
  if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) throw new OAuthError('invalid_client_metadata', 'grant_types: authorization_code and refresh_token only (no implicit flow)');
  if ((m.response_types ?? ['code']).some((r) => r !== 'code')) throw new OAuthError('invalid_client_metadata', 'response_types: code only');
  if (m.scope !== undefined && m.scope.split(' ').some((s) => s !== SCOPE)) throw new OAuthError('invalid_client_metadata', `scope: ${SCOPE}`);
  const clientName = m.client_name?.trim().slice(0, CLIENT_NAME_MAX) || null;

  const info = {
    client_id: `mcp_${randomBytes(16).toString('base64url')}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: [...m.redirect_uris],
    ...(clientName ? { client_name: clientName } : {}),
    token_endpoint_auth_method: 'none',
    grant_types: grants,
    response_types: ['code'],
    scope: SCOPE,
  } satisfies OAuthClientInformationFull;
  await sweepUnusedClients(db);
  // Only what the head uses: the name it shows, where it may send the owner back, and that it has no secret.
  await db.insert(oauthClients).values({ clientId: info.client_id, clientName, redirectUris: info.redirect_uris, tokenEndpointAuthMethod: 'none', createdAt: new Date(now()) });
  return info;
}

/** Registration is open, so it is bounded: a client that never got a device in 7 days is deleted, with its codes. */
async function sweepUnusedClients(db: Db): Promise<void> {
  const before = new Date(Date.parse(now()) - UNUSED_CLIENT_DAYS * 86_400_000);
  const unused = and(lt(oauthClients.createdAt, before), notExists(db.select({ one: sql`1` }).from(devices).where(eq(devices.clientId, oauthClients.clientId))));
  await db.delete(oauthCodes).where(sql`${oauthCodes.clientId} in (select ${oauthClients.clientId} from ${oauthClients} where ${unused})`);
  await db.delete(oauthClients).where(unused);
}

async function client(db: Db, clientId: unknown) {
  if (typeof clientId !== 'string' || clientId === '') return null;
  const [c] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return c ?? null;
}

// --- authorization ---------------------------------------------------------------------------------------------

export interface AuthorizationRequest {
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  state?: string;
}

/** Where the client is sent back after consent: its redirect URI with `params` (and the issuer, RFC 9207). */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>, origin: string): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries({ ...params, iss: origin })) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

/**
 * Whether `uri` is one the client registered: exactly, or, for a loopback http URI, the same but for the port, which a
 * native app picks when it runs (RFC 8252 §7.3).
 */
export function registeredRedirect(registered: readonly string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || u.hash !== '') return false;
  const portless = (x: URL) => `${x.protocol}//${x.hostname}${x.pathname}${x.search}`;
  return registered.some((r) => {
    try {
      const v = new URL(r);
      return v.protocol === 'http:' && LOOPBACK.has(v.hostname) && portless(v) === portless(u);
    } catch {
      return false;
    }
  });
}

/**
 * Checks an authorization request. Every fault found here, before the owner has consented, is refused on the head with
 * a 400 page: nothing goes back to the client's redirect URI until the owner has seen the request and answered.
 */
export async function checkAuthorizationRequest(db: Db, q: URLSearchParams, origin: string): Promise<{ ok: AuthorizationRequest } | { error: OAuthError }> {
  const fail = (error: string, description: string) => ({ error: new OAuthError(error, description) });
  const c = await client(db, q.get('client_id'));
  if (!c) return fail('invalid_client', 'this client is not registered here');
  const redirectUri = q.get('redirect_uri');
  if (!redirectUri || !registeredRedirect(c.redirectUris, redirectUri)) return fail('invalid_request', 'redirect_uri must be one this client registered');
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code (no implicit flow)');
  const challenge = q.get('code_challenge');
  if (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail('invalid_request', 'code_challenge is required (PKCE)');
  if (q.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  const scope = q.get('scope');
  if (scope !== null && scope !== '' && scope.split(' ').some((x) => x !== SCOPE)) return fail('invalid_scope', `the only scope is ${SCOPE}`);
  const resource = q.get('resource') ?? mcpUrl(origin);
  if (!sameResource(resource, origin)) return fail('invalid_target', `resource must be ${mcpUrl(origin)}`);
  const state = q.get('state') ?? undefined;
  if (state !== undefined && state.length > 500) return fail('invalid_request', 'state is at most 500 characters');
  return { ok: { client_id: c.clientId, client_name: c.clientName, redirect_uri: redirectUri, code_challenge: challenge, scope: SCOPE, resource: mcpUrl(origin), ...(state !== undefined ? { state } : {}) } };
}

function sameResource(resource: string, origin: string): boolean {
  try {
    return checkResourceAllowed({ requestedResource: resource, configuredResource: mcpUrl(origin) }) && new URL(resource).href.replace(/\/+$/, '') === mcpUrl(origin);
  } catch {
    return false;
  }
}

/** The checked request, signed, for the consent page to carry back: it cannot be altered on the way. */
export const signRequest = (r: AuthorizationRequest) => sign(REQUEST_AUDIENCE, { req: r }, CODE_TTL_SECONDS);

export async function openRequest(token: unknown): Promise<AuthorizationRequest | null> {
  if (typeof token !== 'string') return null;
  const claims = await verify(REQUEST_AUDIENCE, token);
  return claims && typeof claims.req === 'object' && claims.req !== null ? (claims.req as AuthorizationRequest) : null;
}

/** What the consent page shows, once the head has verified the request: the client's name and where it returns. */
export async function requestInfo(requestToken: unknown): Promise<{ client_name: string | null; redirect_host: string } | null> {
  const r = await openRequest(requestToken);
  return r ? { client_name: r.client_name, redirect_host: new URL(r.redirect_uri).host } : null;
}

/** The owner's answer on the consent page: a code for the client on Allow, access_denied on Deny. Where to go next. */
export async function decide(db: Db, session: Session, requestToken: unknown, allow: boolean, origin: string): Promise<string> {
  const r = await openRequest(requestToken);
  if (!r) throw new OAuthError('invalid_request', 'this authorization request has expired or was altered; start again from the app');
  if (!(await client(db, r.client_id))) throw new OAuthError('invalid_client', 'this client is no longer registered');
  if (!allow) return redirectWith(r.redirect_uri, { error: 'access_denied', error_description: 'the owner did not allow it', state: r.state }, origin);
  const code = randomBytes(32).toString('base64url');
  // Codes are bounded too: those past their 10 minutes are swept as each new one is made.
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date(now())));
  await db.insert(oauthCodes).values({
    codeHash: hash(code),
    clientId: r.client_id,
    headId: session.headId,
    redirectUri: r.redirect_uri,
    codeChallenge: r.code_challenge,
    scope: r.scope,
    resource: r.resource,
    expiresAt: new Date(Date.parse(now()) + CODE_TTL_SECONDS * 1000),
  });
  return redirectWith(r.redirect_uri, { code, state: r.state }, origin);
}

// --- token -------------------------------------------------------------------------------------------------------

const s256 = (verifier: string) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

async function accessToken(headId: string, deviceId: string, origin: string): Promise<string> {
  return sign('session', { sub: headId, did: deviceId, scope: SCOPE, resource: mcpUrl(origin) }, ACCESS_TTL_SECONDS);
}

async function tokens(headId: string, deviceId: string, refresh: string, origin: string): Promise<OAuthTokens> {
  return OAuthTokensSchema.parse({ access_token: await accessToken(headId, deviceId, origin), token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: SCOPE });
}

/** POST /api/oauth/token (application/x-www-form-urlencoded): the authorization_code and refresh_token grants. */
export async function token(db: Db, form: URLSearchParams, origin: string): Promise<OAuthTokens> {
  const grant = form.get('grant_type');
  const clientId = form.get('client_id');
  const c = await client(db, clientId);
  if (!c) throw new OAuthError('invalid_client', 'client_id is not registered here', 401);
  const resource = form.get('resource');
  if (resource !== null && !sameResource(resource, origin)) throw new OAuthError('invalid_target', `resource must be ${mcpUrl(origin)}`);

  if (grant === 'authorization_code') {
    const code = form.get('code');
    const verifier = form.get('code_verifier');
    if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required');
    const at = new Date(now());
    const issued = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hash(code))).for('update');
      type Out = { fail: string; headId?: never; deviceId?: never; refresh?: never } | { fail?: undefined; headId: string; deviceId: string; refresh: string };
      const fail = (f: string): Out => ({ fail: f });
      if (!row) return fail('the code is not valid');
      if (row.usedAt !== null) {
        // Presented again: whoever has it now is not the client it was for. Sign out what its first use made.
        if (row.deviceId) await tx.update(devices).set({ revokedAt: new Date(), refreshTokenHash: null }).where(and(eq(devices.id, row.deviceId), isNull(devices.revokedAt)));
        return fail('the code was already used');
      }
      // A failed attempt still uses the code up: a code is good for one try.
      await tx.update(oauthCodes).set({ usedAt: at }).where(eq(oauthCodes.codeHash, row.codeHash));
      if (row.expiresAt <= at) return fail('the code has expired');
      if (row.clientId !== c.clientId) return fail('the code was issued to another client');
      if (form.get('redirect_uri') !== row.redirectUri) return fail('redirect_uri does not match the authorization request');
      if (s256(verifier) !== row.codeChallenge) return fail('code_verifier does not match the code_challenge');
      const deviceId = randomUUID();
      const refresh = newRefreshFamily();
      await tx.insert(devices).values({
        id: deviceId, headId: row.headId, identityId: null, platform: MCP_PLATFORM, name: c.clientName ?? 'An assistant', clientId: c.clientId,
        refreshTokenHash: hash(refresh.token), refreshFamily: refresh.family, refreshGeneration: 0,
        refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000), lastSeenAt: new Date(),
      });
      await tx.update(oauthCodes).set({ deviceId }).where(eq(oauthCodes.codeHash, row.codeHash));
      return { headId: row.headId, deviceId, refresh: refresh.token } satisfies Out as Out;
    });
    if (issued.fail !== undefined) throw new OAuthError('invalid_grant', issued.fail);
    return tokens(issued.headId, issued.deviceId, issued.refresh, origin);
  }

  if (grant === 'refresh_token') {
    const refresh = form.get('refresh_token');
    if (!refresh) throw new OAuthError('invalid_request', 'refresh_token is required');
    const rotated = await rotateRefresh(db, refresh, (d) => d.platform === MCP_PLATFORM && d.clientId === c.clientId);
    if (!rotated) throw new OAuthError('invalid_grant', 'the refresh token is not valid, has expired, or its assistant was signed out');
    return tokens(rotated.device.headId, rotated.device.id, rotated.next, origin);
  }

  throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

// --- the resource: /api/mcp --------------------------------------------------------------------------------------

/** The Bearer token from a request, or null. */
const bearer = (req: Request) => /^Bearer +(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;

/**
 * `Authorization: Bearer <access token>` on /api/mcp: an access token this server issued (scope `owner`, for this MCP
 * URL) for an assistant's device still signed in. A producer token is not a JWT and fails; a web session's access
 * token has no scope and fails. Null when refused; the route answers 401 with where to authorise.
 */
export async function authenticateAssistant(db: Db, req: Request, origin: string): Promise<Session | null> {
  const t = bearer(req);
  if (!t) return null;
  const claims = await verify('session', t);
  if (!claims || claims.scope !== SCOPE || claims.resource !== mcpUrl(origin) || typeof claims.sub !== 'string' || typeof claims.did !== 'string') return null;
  const [device] = await db
    .select({ id: devices.id, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(and(eq(devices.id, claims.did), eq(devices.headId, claims.sub), eq(devices.platform, MCP_PLATFORM), isNull(devices.revokedAt)));
  if (!device) return null;
  // "Last use" for Settings, to the minute.
  if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 60_000) await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
  return { headId: claims.sub, deviceId: claims.did };
}

/** The 401 an MCP client reads to find the authorization server (RFC 9728 §5.1). */
export function unauthorized(origin: string, description = 'an access token from this head’s authorization server is required'): Response {
  return Response.json(
    { error: 'invalid_token', error_description: description },
    { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(origin)}", error="invalid_token", scope="${SCOPE}"`, ...NO_STORE } },
  );
}

/** The access token itself, for the tools to call /api/me with (it is a Session JWT). */
export const presentedToken = (req: Request) => bearer(req);
