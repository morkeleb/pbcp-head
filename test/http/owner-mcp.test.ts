// The owner's MCP server (packages/owner-mcp) and the OAuth that lets an assistant use it (lib/oauth.ts): the metadata,
// a whole registration + consent + PKCE + token flow driven by the MCP SDK's own client, every tool over /api/mcp
// (refusals included), the flow's refusals by status and code, refresh families, signing out, scoped tokens confined to
// the tool routes, credentials never mixed, storage bounds, and the stdio binary.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, exchangeAuthorization, registerClient, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, type OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devices, oauthClients, oauthCodes } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { startSession } from '../../lib/auth/session';
import { requirePublicOrigin } from '../../lib/boot';
import { parseSession } from '../../packages/owner-mcp/src/stdio-session';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

let owner: { auth: string; deviceId: string };
let hermes: string;
const REDIRECT = 'https://assistant.example/oauth/callback';
const mcpUrl = () => `${headUrl()}/api/mcp`;

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z', rateLimits: null } });
  owner = await ownerSession(OWNER, 'laptop');
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', ceiling: 'immediate' })}`;
  await call('PUT', cardPath('hermes:mail:anna'), { auth: hermes, body: card('hermes:mail:anna', { title: 'Reply to Anna re invoice timing', summary: 'Anna asks to pay on the 20th.', labels: ['billing'], actions: [{ id: 'agree', label: 'Agree', default: true }, 'reject', 'edit'] }) });
  await call('PUT', cardPath('hermes:report:1'), { auth: hermes, body: card('hermes:report:1', { kind: 'artifact', title: 'Weekly report', summary: 'All green.' }) });
});
afterEach(() => call('POST', '/api/test', { body: { clock: null, rateLimits: null } }));

// --- helpers ---------------------------------------------------------------------------------------------------

const verifier = () => randomBytes(32).toString('base64url');
const challenge = (v: string) => createHash('sha256').update(v).digest('base64url');

/** POST /api/oauth/token as a client would: form-encoded. Status and the OAuth error code, or the tokens. */
async function tokenRequest(form: Record<string, string>) {
  const r = await fetch(`${headUrl()}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

async function register(redirect_uris = [REDIRECT], extra: Record<string, unknown> = {}, from?: string) {
  const r = await fetch(`${headUrl()}/api/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', ...(from ? { 'x-real-ip': from } : {}) }, body: JSON.stringify({ client_name: 'Test assistant', redirect_uris, ...extra }) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** GET /api/oauth/authorize with `params`; the status, where it sends the browser, and the refusal's code. */
async function authorize(params: Record<string, string>) {
  const u = new URL(`${headUrl()}/api/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), error: r.headers.get('oauth-error'), body: r.status === 400 ? await r.text() : '' };
}

/** A registered client, the owner's consent, and a code with its verifier (the flow without the SDK, for refusals). */
async function code(opts: { clientId?: string; redirect?: string } = {}) {
  const clientId = opts.clientId ?? ((await register([opts.redirect ?? REDIRECT])).body.client_id as string);
  const v = verifier();
  const a = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: opts.redirect ?? REDIRECT, code_challenge: challenge(v), code_challenge_method: 'S256', state: 's1', scope: 'owner' });
  expect(a.status).toBe(302);
  const request = new URL(a.location!).searchParams.get('request');
  const r = await call('POST', '/api/oauth/authorize', { auth: owner.auth, body: { request, allow: true } });
  return { clientId, verifier: v, code: new URL(r.body.redirect).searchParams.get('code')! };
}

const exchange = (c: { clientId: string; verifier: string; code: string }, extra: Record<string, string> = {}) =>
  tokenRequest({ grant_type: 'authorization_code', client_id: c.clientId, code: c.code, code_verifier: c.verifier, redirect_uri: REDIRECT, ...extra });

/** Registration, consent and exchange through the SDK's client functions: what a real MCP client does. */
async function connect(opts: { allow?: boolean } = {}) {
  const meta = (await discoverAuthorizationServerMetadata(headUrl()))!;
  const client = await registerClient(headUrl(), { metadata: meta, clientMetadata: { client_name: 'Test assistant', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'owner' } });
  const state = 'st4te-' + Math.random().toString(36).slice(2);
  const { authorizationUrl, codeVerifier } = await startAuthorization(headUrl(), { metadata: meta, clientInformation: client, redirectUrl: REDIRECT, scope: 'owner', state, resource: mcpUrl() });
  const go = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(go.status).toBe(302);
  const consentUrl = new URL(go.headers.get('location')!);
  expect(consentUrl.pathname).toBe('/oauth/consent');
  const r = await call('POST', '/api/oauth/authorize', { auth: owner.auth, body: { request: consentUrl.searchParams.get('request'), allow: opts.allow ?? true } });
  expect(r.status).toBe(200);
  const back = new URL(r.body.redirect);
  expect(back.searchParams.get('state')).toBe(state);
  expect(back.searchParams.get('iss')).toBe(headUrl());
  return { meta, client, code: back.searchParams.get('code'), error: back.searchParams.get('error'), codeVerifier, request: consentUrl.searchParams.get('request') };
}

async function tokens() {
  const c = await connect();
  const t = await exchangeAuthorization(headUrl(), { metadata: c.meta, clientInformation: c.client, authorizationCode: c.code!, codeVerifier: c.codeVerifier, redirectUri: REDIRECT, resource: mcpUrl() });
  return { ...c, tokens: t };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl()), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return client;
}

const parse = (r: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
const refresh = (clientId: string, refreshToken: string) => tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken });

// --- tests -----------------------------------------------------------------------------------------------------------

describe('metadata', () => {
  it('publishes authorization server and protected resource metadata that validate and point at each other', async () => {
    const as = await (await fetch(`${headUrl()}/.well-known/oauth-authorization-server`)).json();
    expect(OAuthMetadataSchema.parse(as)).toMatchObject({
      issuer: headUrl(),
      authorization_endpoint: `${headUrl()}/api/oauth/authorize`,
      token_endpoint: `${headUrl()}/api/oauth/token`,
      registration_endpoint: `${headUrl()}/api/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp']) {
      const pr = await (await fetch(`${headUrl()}${path}`)).json();
      expect(OAuthProtectedResourceMetadataSchema.parse(pr)).toMatchObject({ resource: mcpUrl(), authorization_servers: [headUrl()], scopes_supported: ['owner'] });
    }
    const r = await fetch(mcpUrl(), { method: 'POST' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${headUrl()}/.well-known/oauth-protected-resource"`);
    expect((await r.json()).error).toBe('invalid_token');
    expect((await discoverOAuthProtectedResourceMetadata(mcpUrl())).authorization_servers).toEqual([headUrl()]);
  });

  it('takes the issuer from WEBAUTHN_ORIGIN, never a Host header, and the head will not start without it', async () => {
    const as = await (await fetch(`${headUrl()}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-host': 'evil.example', host: 'evil.example' } })).json();
    expect(as.issuer).toBe(headUrl());
    expect(() => requirePublicOrigin({})).toThrow(/WEBAUTHN_ORIGIN must be set/);
    expect(() => requirePublicOrigin({ WEBAUTHN_ORIGIN: 'https://head.example/path' })).toThrow(/no path/);
    expect(() => requirePublicOrigin({ WEBAUTHN_ORIGIN: 'https://head.example' })).not.toThrow();
  });
});

describe('the whole flow', () => {
  it('registers, gets the owner’s consent, exchanges the code with PKCE, and the access token lists the tools and calls brief and decide', async () => {
    const { tokens: t } = await tokens();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'owner', refresh_token: expect.stringMatching(/^pbcp_rt_[A-Za-z0-9_-]{22}\.0\./) });
    const client = await mcpClient(t.access_token);
    expect((await client.listTools()).tools.map((x) => x.name).sort()).toEqual(['acknowledge', 'brief', 'create_order', 'decide', 'get_card', 'list_cards', 'snooze', 'unsnooze']);
    const brief = parse(await client.callTool({ name: 'brief', arguments: {} }));
    expect(brief.date).toBe('2026-10-07');
    expect(brief.decisions).toEqual([expect.objectContaining({ id: 'hermes:mail:anna', title: 'Reply to Anna re invoice timing', lead: 'Anna asks to pay on the 20th.', labels: ['billing'], editable: true, actions: [{ id: 'agree', label: 'Agree', default: true }, { id: 'reject', label: 'reject' }] })]);
    expect(brief.updates).toEqual([expect.objectContaining({ id: 'hermes:report:1', title: 'Weekly report' })]);
    expect(brief.paragraph).toMatch(/^1 decision: Reply to Anna re invoice timing — Anna asks to pay on the 20th\./);
    const decided = parse(await client.callTool({ name: 'decide', arguments: { id: 'hermes:mail:anna', decision: 'agree', comment: 'Fine by me.' } }));
    expect(decided).toMatchObject({ id: 'hermes:mail:anna', state: 'decided', decision: 'agree', comment: 'Fine by me.' });
    const list = (await call('GET', '/api/me/settings/devices', { auth: owner.auth })).body.devices;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Test assistant', platform: 'mcp' })]));
  });

  it('sends access_denied back when the owner denies; the answer needs the owner’s own session; a tampered request is refused', async () => {
    const denied = await connect({ allow: false });
    expect([denied.code, denied.error]).toEqual([null, 'access_denied']);
    const c = await connect();
    const answer = (auth: string | undefined, request: string | null) => call('POST', '/api/oauth/authorize', { ...(auth ? { auth } : {}), body: { request, allow: true } });
    let r = await answer(undefined, c.request);
    expect([r.status, r.body.error]).toEqual([401, 'unauthorized']);
    r = await answer(hermes, c.request);
    expect([r.status, r.body.error]).toEqual([401, 'unauthorized']);
    r = await answer(owner.auth, `${c.request}x`);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
  });
});

describe('every tool, over /api/mcp', () => {
  it('reads, filters, and acts; refusals come back with the head’s status and code', async () => {
    const client = await mcpClient((await tokens()).tokens.access_token);
    const tool = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const refused = async (name: string, args: Record<string, unknown>) => {
      const r = await tool(name, args);
      expect(r.isError, name).toBe(true);
      return parse(r) as { error: string; status: number };
    };

    expect(parse(await tool('list_cards', { from: '2026-10-07', label: 'billing' })).cards.map((c: { id: string }) => c.id)).toEqual(['hermes:mail:anna']);
    expect(parse(await tool('list_cards', { from: '2026-10-07', kind: 'artifact' })).cards.map((c: { id: string }) => c.id)).toEqual(['hermes:report:1']);
    expect(parse(await tool('list_cards', {})).from).toBe('2026-10-01');

    const got = parse(await tool('get_card', { id: 'hermes:mail:anna' }));
    expect(got.card.body).toBe('Evidence.\n\n## Proposal\n\nDo the thing.');
    expect(JSON.stringify(got)).not.toMatch(/<h2|<p>/);
    expect(got.card.actions[0]).toEqual({ id: 'agree', label: 'Agree', default: true });
    expect(await refused('get_card', { id: 'hermes:mail:nope' })).toMatchObject({ error: 'not_found', status: 404 });

    expect(parse(await tool('acknowledge', { id: 'hermes:report:1' }))).toMatchObject({ id: 'hermes:report:1', acknowledged_at: expect.any(String) });
    expect(await refused('acknowledge', { id: 'hermes:mail:anna' })).toMatchObject({ error: 'not_acknowledgeable', status: 400 });

    expect(parse(await tool('snooze', { id: 'hermes:mail:anna', until: '2026-10-08T07:00:00Z' }))).toEqual({ id: 'hermes:mail:anna', snoozed_until: '2026-10-08T07:00:00Z' });
    expect(await refused('snooze', { id: 'hermes:mail:anna', until: '2026-10-08T09:00:00+02:00' })).toMatchObject({ error: 'invalid_snooze', status: 400 });
    expect(parse(await tool('brief', {})).snoozed).toBe(1);
    expect(parse(await tool('unsnooze', { id: 'hermes:mail:anna' }))).toMatchObject({ id: 'hermes:mail:anna', snoozed_until: null });

    expect(await refused('decide', { id: 'hermes:mail:anna', decision: 'maybe' })).toMatchObject({ error: 'invalid_decision', status: 400 });
    expect(parse(await tool('decide', { id: 'hermes:mail:anna', decision: 'edited', edited: 'Only for September.' }))).toMatchObject({ decision: 'edited', edited_proposal: 'Only for September.' });
    expect(await refused('decide', { id: 'hermes:mail:anna', decision: 'agree' })).toMatchObject({ error: 'not_open', status: 409 });

    expect(parse(await tool('create_order', { title: 'Renew the parking permit', to_producer: '*', body: 'Zone 4.' }))).toMatchObject({ id: expect.stringMatching(/^head:order:/), to_producer: '*', exec_state: 'open' });

    await call('POST', '/api/test', { body: { clock: '2026-10-08T09:00:00Z' } });
    expect(parse(await tool('brief', { day: '2026-10-07' }))).toMatchObject({ date: '2026-10-07', decisions: [expect.objectContaining({ id: 'hermes:mail:anna', state: 'decided', decision: 'edited' })] });
  });
});

describe('scoped tokens are confined to the tools', () => {
  it('opens each route a tool calls to the assistant’s token, and refuses every other owner route with 403 insufficient_scope', async () => {
    const { tokens: t } = await tokens();
    const as = `Session ${t.access_token}`;
    const id = encodeURIComponent('hermes:mail:anna');
    const ok: Array<[string, string, unknown?]> = [
      ['GET', '/api/me/brief'],
      ['GET', '/api/me/cards?date=2026-10-07'],
      ['GET', `/api/me/cards/${id}`],
      ['POST', `/api/me/cards/${id}/seen`],
      ['POST', `/api/me/cards/${id}/snooze`, { until: '2026-10-08T07:00:00Z' }],
      ['POST', `/api/me/cards/${id}/unsnooze`],
      ['POST', `/api/me/cards/${encodeURIComponent('hermes:report:1')}/ack`],
      ['POST', `/api/me/cards/${id}/decision`, { decision: 'agree' }],
      ['POST', '/api/me/orders', { title: 'Book a table', to_producer: '*' }],
    ];
    for (const [method, path, body] of ok) {
      const r = await call(method, path, { auth: as, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${method} ${path}`).toBeLessThan(300);
    }
    const refused: Array<[string, string, unknown?]> = [
      ['POST', '/api/oauth/authorize', { request: 'x', allow: true }], // consent
      ['GET', '/api/oauth/request?request=x'],
      ['POST', '/api/me/settings/enrolment'],
      ['POST', '/api/me/settings/pairing'],
      ['DELETE', `/api/me/settings/devices/${owner.deviceId}`],
      ['POST', '/api/me/settings/producers', { root: 'sneaky' }],
      ['GET', '/api/me/settings'],
      ['GET', '/api/me/settings/devices'],
      ['GET', '/api/me/devices'],
      ['DELETE', `/api/me/devices/${owner.deviceId}`],
      ['PATCH', '/api/me/producers/hermes', { ceiling: 'immediate' }],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/passkey/register/options', {}],
      ['GET', '/api/me/orders'],
      ['POST', '/api/me/visit', {}],
    ];
    for (const [method, path, body] of refused) {
      const r = await call(method, path, { auth: as, ...(body !== undefined ? { body } : {}) });
      expect([r.status, r.body.error], `${method} ${path}`).toEqual([403, 'insufficient_scope']);
    }
    // Nothing was done: the owner's device is still signed in, no producer was minted.
    expect((await call('GET', '/api/me/settings/devices', { auth: owner.auth })).status).toBe(200);
    expect((await call('GET', '/api/me/settings/producers', { auth: owner.auth })).body.producers.map((p: { root: string }) => p.root)).toEqual(['hermes']);
  });
});

describe('refusals in the flow, by status and code', () => {
  it('refuses every fault before consent on the head, never redirecting: response_type=token, no PKCE, plain, scope, bad redirect', async () => {
    const attacker = 'https://attacker.example/cb';
    const clientId = (await register([attacker])).body.client_id as string;
    const v = verifier();
    const base = { client_id: clientId, redirect_uri: attacker, code_challenge: challenge(v), code_challenge_method: 'S256', state: 's' };
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...base, response_type: 'token' }, 'unsupported_response_type'],
      [{ ...base, response_type: 'code', code_challenge: '' }, 'invalid_request'],
      [{ ...base, response_type: 'code', code_challenge_method: 'plain' }, 'invalid_request'],
      [{ ...base, response_type: 'code', code_challenge: v, code_challenge_method: 'plain' }, 'invalid_request'],
      [{ ...base, response_type: 'code', scope: 'admin' }, 'invalid_scope'],
      [{ ...base, response_type: 'code', resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ ...base, response_type: 'code', redirect_uri: 'https://elsewhere.example/cb' }, 'invalid_request'],
      [{ ...base, response_type: 'code', client_id: 'mcp_unknown' }, 'invalid_client'],
    ];
    for (const [params, error] of cases) {
      const a = await authorize(params);
      expect([a.status, a.location, a.error], JSON.stringify(params)).toEqual([400, null, error]);
      expect(a.body).toContain(`<code data-error>${error}</code>`);
    }
  });

  it('refuses at the token endpoint with invalid_grant: a wrong verifier (then the right one too), a reused code, an expired code, a mismatched redirect_uri', async () => {
    const wrong = await code();
    let r = await exchange({ ...wrong, verifier: verifier() });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
    r = await exchange(wrong);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);

    const once = await code();
    r = await exchange(once);
    expect(r.status).toBe(200);
    const first = r.body;
    r = await exchange(once);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
    expect((await fetch(mcpUrl(), { method: 'POST', headers: { authorization: `Bearer ${first.access_token}` } })).status).toBe(401); // its device was signed out

    const late = await code();
    await call('POST', '/api/test', { body: { clock: '2026-10-07T09:10:00Z' } });
    r = await exchange(late);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);

    await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z' } });
    const elsewhere = await code();
    r = await exchange(elsewhere, { redirect_uri: 'https://assistant.example/other' });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);

    r = await tokenRequest({ grant_type: 'password', client_id: elsewhere.clientId });
    expect([r.status, r.body.error]).toEqual([400, 'unsupported_grant_type']);
    r = await tokenRequest({ grant_type: 'authorization_code', client_id: 'mcp_unknown', code: 'x', code_verifier: 'y' });
    expect([r.status, r.body.error]).toEqual([401, 'invalid_client']);
  });

  it('registers only public clients with https or loopback http redirects, reads a bounded body, and rate-limits registration', async () => {
    let r = await register(['http://assistant.example/cb']);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_redirect_uri']);
    r = await register(['https://assistant.example/cb#frag']);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_redirect_uri']);
    r = await register(['https://assistant.example/cb'], { token_endpoint_auth_method: 'client_secret_basic' });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_client_metadata']);
    r = await register(['https://assistant.example/cb'], { grant_types: ['implicit'] });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_client_metadata']);
    r = await register(['http://127.0.0.1/callback']);
    expect(r.status).toBe(201);
    const big = await fetch(`${headUrl()}/api/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(2 * 1024 * 1024) }) });
    expect([big.status, (await big.json()).error]).toEqual([413, 'invalid_client_metadata']);
  });

  it('rate-limits registration per address with 429 rate_limited', async () => {
    await call('POST', '/api/test', { body: { rateLimits: { auth: 3 } } });
    const from = `198.51.100.${Math.floor(Math.random() * 250) + 1}-${Date.now()}`; // its own window, whatever ran before
    for (let i = 0; i < 3; i++) expect((await register([REDIRECT], {}, from)).status).toBe(201);
    const r = await register([REDIRECT], {}, from);
    expect([r.status, r.body.error]).toEqual([429, 'rate_limited']);
    expect((await register([REDIRECT], {}, `${from}-other`)).status).toBe(201);
  });

  it('accepts any port on a registered loopback redirect (RFC 8252), and only on loopback', async () => {
    const clientId = (await register(['http://127.0.0.1/callback'])).body.client_id as string;
    const v = verifier();
    const p = { response_type: 'code', client_id: clientId, code_challenge: challenge(v), code_challenge_method: 'S256' };
    expect((await authorize({ ...p, redirect_uri: 'http://127.0.0.1:54321/callback' })).status).toBe(302);
    expect((await authorize({ ...p, redirect_uri: 'http://127.0.0.1:54321/other' })).error).toBe('invalid_request');
  });
});

describe('refresh token families', () => {
  it('rotates; presenting any earlier generation signs the assistant out, and then nothing of the family works', async () => {
    const { client, tokens: t } = await tokens();
    const g0 = t.refresh_token!;
    let r = await refresh(client.client_id, g0);
    expect(r.status).toBe(200);
    const g1 = r.body.refresh_token!;
    expect(g1).toMatch(/\.1\./);
    r = await refresh(client.client_id, g1);
    const g2 = r.body.refresh_token!;
    expect(g2).toMatch(/\.2\./);
    expect((await (await mcpClient(r.body.access_token!)).listTools()).tools).toHaveLength(8);

    r = await refresh(client.client_id, g0); // two generations back
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
    r = await refresh(client.client_id, g2); // the current one, now dead
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
    const device = (await testDb().select().from(devices).where(eq(devices.clientId, client.client_id)))[0]!;
    expect(device.revokedAt).not.toBeNull();
  });

  it('does the same for the web: a sign-in’s refresh token from two generations back signs the device out', async () => {
    const s = await startSession(testDb(), { headId: OWNER, identityId: null, platform: 'web', name: 'phone' });
    const a = await call('POST', '/api/auth/refresh', { body: { refresh_token: s.refresh_token } });
    const b = await call('POST', '/api/auth/refresh', { body: { refresh_token: a.body.refresh_token } });
    expect(b.status).toBe(200);
    const old = await call('POST', '/api/auth/refresh', { body: { refresh_token: s.refresh_token } });
    expect([old.status, old.body.error]).toEqual([401, 'unauthorized']);
    const current = await call('POST', '/api/auth/refresh', { body: { refresh_token: b.body.refresh_token } });
    expect([current.status, current.body.error]).toEqual([401, 'unauthorized']);
  });

  it('binds a refresh token to its client, and refuses a signed-out assistant’s refresh and access tokens', async () => {
    const { meta, client, tokens: t } = await tokens();
    const other = await registerClient(headUrl(), { metadata: meta, clientMetadata: { client_name: 'Other', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } as never });
    let r = await refresh((other as OAuthClientInformationFull).client_id, t.refresh_token!);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
    const device = (await call('GET', '/api/me/settings/devices', { auth: owner.auth })).body.devices.find((d: { platform: string }) => d.platform === 'mcp');
    expect((await call('DELETE', `/api/me/settings/devices/${device.id}`, { auth: owner.auth })).status).toBe(204);
    r = await refresh(client.client_id, t.refresh_token!);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
    const mcp = await fetch(mcpUrl(), { method: 'POST', headers: { authorization: `Bearer ${t.access_token}` } });
    expect([mcp.status, (await mcp.json()).error]).toEqual([401, 'invalid_token']);
    expect((await call('GET', '/api/me/brief', { auth: `Session ${t.access_token}` })).status).toBe(401);
  });
});

describe('storage bounds', () => {
  it('sweeps expired codes as new ones are made, and deletes clients that never got a device after 7 days', async () => {
    await code();
    await call('POST', '/api/test', { body: { clock: '2026-10-07T09:20:00Z' } });
    await code();
    expect(await testDb().select().from(oauthCodes)).toHaveLength(1); // the expired one went as the new one came

    const unused = (await register()).body.client_id as string;
    const used = await tokens();
    await call('POST', '/api/test', { body: { clock: '2026-10-15T09:00:00Z' } });
    await register();
    const ids = (await testDb().select({ id: oauthClients.clientId }).from(oauthClients)).map((c) => c.id);
    expect(ids).not.toContain(unused);
    expect(ids).toContain(used.client.client_id);
    const row = (await testDb().select().from(oauthClients).where(eq(oauthClients.clientId, used.client.client_id)))[0]!;
    expect(Object.keys(row).sort()).toEqual(['clientId', 'clientName', 'createdAt', 'redirectUris', 'tokenEndpointAuthMethod']);
  });
});

describe('two credential types, never mixed', () => {
  it('refuses a producer token and a web session on /api/mcp, and an access token on a producer route', async () => {
    const { tokens: t } = await tokens();
    const post = async (authorization: string) => {
      const r = await fetch(mcpUrl(), { method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      return [r.status, (await r.json()).error];
    };
    expect(await post(hermes)).toEqual([401, 'invalid_token']);
    expect(await post(`Bearer ${owner.auth.replace(/^Session /, '')}`)).toEqual([401, 'invalid_token']);
    expect(await post(owner.auth)).toEqual([401, 'invalid_token']);
    let r = await call('PUT', cardPath('hermes:x:1'), { auth: `Bearer ${t.access_token}`, body: card('hermes:x:1') });
    expect([r.status, r.body.error]).toEqual([401, 'unauthorized']);
    r = await call('GET', '/api/changes?after=0', { auth: `Bearer ${t.access_token}` });
    expect([r.status, r.body.error]).toEqual([401, 'unauthorized']);
    r = await call('POST', '/api/auth/refresh', { body: { refresh_token: t.refresh_token } });
    expect([r.status, r.body.error]).toEqual([401, 'unauthorized']);
  });
});

describe('the stdio binary', () => {
  it('refuses a producer token as PBCP_SESSION, and serves the tools with a session from login', async () => {
    expect(() => parseSession('pbcp_abc')).toThrow(/producer token/);
    expect(() => parseSession(undefined)).toThrow(/login/);
    const { client, tokens: t } = await tokens();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', join(process.cwd(), 'packages/owner-mcp/src/stdio.ts')],
      env: { ...process.env, PBCP_HEAD_URL: headUrl(), PBCP_SESSION: `${client.client_id}:${t.refresh_token}`, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'pbcp-owner-mcp-')) } as Record<string, string>,
      stderr: 'pipe',
    });
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(transport);
    try {
      expect(parse(await c.callTool({ name: 'brief', arguments: {} })).decisions[0].id).toBe('hermes:mail:anna');
    } finally {
      await c.close();
    }
  }, 30_000);
});
