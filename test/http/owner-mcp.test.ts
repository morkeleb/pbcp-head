// The owner's MCP server (packages/owner-mcp) and the OAuth that lets an assistant use it (lib/oauth.ts): the metadata,
// a whole registration + consent + PKCE + token flow driven by the MCP SDK's own client, every tool over /api/mcp
// (refusals included), the flow's refusals, refresh rotation, signing out, credentials never mixed, and the stdio binary.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, type OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
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

/** Registration, consent (the signed-in owner allows), and the code exchange, all through the SDK's client functions. */
async function connect(opts: { redirect?: string; allow?: boolean } = {}) {
  const meta = (await discoverAuthorizationServerMetadata(headUrl()))!;
  const client = await registerClient(headUrl(), { metadata: meta, clientMetadata: { client_name: 'Test assistant', redirect_uris: [opts.redirect ?? REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'owner' } });
  const state = 'st4te-' + Math.random().toString(36).slice(2);
  const { authorizationUrl, codeVerifier } = await startAuthorization(headUrl(), { metadata: meta, clientInformation: client, redirectUrl: opts.redirect ?? REDIRECT, scope: 'owner', state, resource: mcpUrl() });
  const code = await consent(authorizationUrl, opts.allow ?? true, state);
  return { meta, client, code, codeVerifier, state };
}

async function consent(authorizationUrl: URL, allow: boolean, state: string): Promise<string> {
  const go = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(go.status).toBe(302);
  const consentUrl = new URL(go.headers.get('location')!);
  expect(consentUrl.pathname).toBe('/oauth/consent');
  const r = await call('POST', '/api/oauth/authorize', { auth: owner.auth, body: { request: consentUrl.searchParams.get('request'), allow } });
  expect(r.status).toBe(200);
  const back = new URL(r.body.redirect);
  expect(back.searchParams.get('state')).toBe(state);
  expect(back.searchParams.get('iss')).toBe(headUrl());
  return back.searchParams.get('code') ?? `error:${back.searchParams.get('error')}`;
}

async function tokens() {
  const c = await connect();
  const t = await exchangeAuthorization(headUrl(), { metadata: c.meta, clientInformation: c.client, authorizationCode: c.code, codeVerifier: c.codeVerifier, redirectUri: REDIRECT, resource: mcpUrl() });
  return { ...c, tokens: t };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl()), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return client;
}

const parse = (r: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

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
    // As an MCP client finds them: from the resource's 401.
    const r = await fetch(mcpUrl(), { method: 'POST' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${headUrl()}/.well-known/oauth-protected-resource"`);
    expect((await discoverOAuthProtectedResourceMetadata(mcpUrl())).authorization_servers).toEqual([headUrl()]);
  });
});

describe('the whole flow', () => {
  it('registers, gets the owner’s consent, exchanges the code with PKCE, and the access token lists the tools and calls brief and decide', async () => {
    const { tokens: t } = await tokens();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'owner', refresh_token: expect.stringMatching(/^pbcp_rt_/) });
    const client = await mcpClient(t.access_token);
    expect((await client.listTools()).tools.map((x) => x.name).sort()).toEqual(['acknowledge', 'brief', 'create_order', 'decide', 'get_card', 'list_cards', 'snooze', 'unsnooze']);
    const brief = parse(await client.callTool({ name: 'brief', arguments: {} }));
    expect(brief.date).toBe('2026-10-07');
    expect(brief.decisions).toEqual([expect.objectContaining({ id: 'hermes:mail:anna', title: 'Reply to Anna re invoice timing', lead: 'Anna asks to pay on the 20th.', labels: ['billing'], editable: true, actions: [{ id: 'agree', label: 'Agree', default: true }, { id: 'reject', label: 'reject' }] })]);
    expect(brief.updates).toEqual([expect.objectContaining({ id: 'hermes:report:1', title: 'Weekly report' })]);
    expect(brief.paragraph).toMatch(/^1 decision: Reply to Anna re invoice timing — Anna asks to pay on the 20th\./);
    const decided = parse(await client.callTool({ name: 'decide', arguments: { id: 'hermes:mail:anna', decision: 'agree', comment: 'Fine by me.' } }));
    expect(decided).toMatchObject({ id: 'hermes:mail:anna', state: 'decided', decision: 'agree', comment: 'Fine by me.' });
    // Recorded as the assistant's device, which Settings lists.
    const devices = (await call('GET', '/api/me/settings/devices', { auth: owner.auth })).body.devices;
    expect(devices).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Test assistant', platform: 'mcp' })]));
  });

  it('sends access_denied back when the owner denies, and requires a signed-in owner to answer', async () => {
    const c = await connect({ allow: false });
    expect(c.code).toBe('error:access_denied');
    const meta = c.meta;
    const { authorizationUrl } = await startAuthorization(headUrl(), { metadata: meta, clientInformation: c.client, redirectUrl: REDIRECT, scope: 'owner', state: 's', resource: mcpUrl() });
    const request = new URL((await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location')!).searchParams.get('request');
    expect((await call('POST', '/api/oauth/authorize', { body: { request, allow: true } })).status).toBe(401);
    expect((await call('POST', '/api/oauth/authorize', { auth: hermes, body: { request, allow: true } })).status).toBe(401);
    // The signed request cannot be altered on the way.
    expect((await call('POST', '/api/oauth/authorize', { auth: owner.auth, body: { request: `${request}x`, allow: true } })).body.error).toBe('invalid_request');
  });
});

describe('every tool, over /api/mcp', () => {
  it('reads, filters, and acts; refusals come back in the head’s words', async () => {
    const client = await mcpClient((await tokens()).tokens.access_token);
    const tool = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    const list = parse(await tool('list_cards', { from: '2026-10-07', label: 'billing' }));
    expect(list.cards.map((c: { id: string }) => c.id)).toEqual(['hermes:mail:anna']);
    expect(parse(await tool('list_cards', { from: '2026-10-07', kind: 'artifact' })).cards.map((c: { id: string }) => c.id)).toEqual(['hermes:report:1']);
    expect(parse(await tool('list_cards', {})).from).toBe('2026-10-01'); // the last seven days

    const got = parse(await tool('get_card', { id: 'hermes:mail:anna' }));
    expect(got.card.body).toBe('Evidence.\n\n## Proposal\n\nDo the thing.'); // markdown, never HTML
    expect(JSON.stringify(got)).not.toMatch(/<h2|<p>/);
    expect(got.card.actions[0]).toEqual({ id: 'agree', label: 'Agree', default: true });

    const missing = await tool('get_card', { id: 'hermes:mail:nope' });
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({ error: 'not_found', status: 404 });

    expect(parse(await tool('acknowledge', { id: 'hermes:report:1' }))).toMatchObject({ id: 'hermes:report:1', acknowledged_at: expect.any(String) });
    const ackDecision = await tool('acknowledge', { id: 'hermes:mail:anna' });
    expect(ackDecision.isError).toBe(true);

    expect(parse(await tool('snooze', { id: 'hermes:mail:anna', until: '2026-10-08T07:00:00Z' }))).toEqual({ id: 'hermes:mail:anna', snoozed_until: '2026-10-08T07:00:00Z' });
    expect((await tool('snooze', { id: 'hermes:mail:anna', until: '2026-10-08T09:00:00+02:00' })).isError).toBe(true);
    expect(parse(await tool('brief', {})).snoozed).toBe(1);
    expect(parse(await tool('unsnooze', { id: 'hermes:mail:anna' }))).toMatchObject({ id: 'hermes:mail:anna', snoozed_until: null });

    const notAChoice = await tool('decide', { id: 'hermes:mail:anna', decision: 'maybe' });
    expect(notAChoice.isError).toBe(true);
    expect(parse(notAChoice).status).toBe(400);
    expect(parse(await tool('decide', { id: 'hermes:mail:anna', decision: 'edited', edited: 'Only for September.' }))).toMatchObject({ decision: 'edited', edited_proposal: 'Only for September.' });
    const again = await tool('decide', { id: 'hermes:mail:anna', decision: 'agree' });
    expect(again.isError).toBe(true);
    expect(parse(again)).toMatchObject({ error: 'not_open', status: 409 });

    const order = parse(await tool('create_order', { title: 'Renew the parking permit', to_producer: '*', body: 'Zone 4.' }));
    expect(order).toMatchObject({ id: expect.stringMatching(/^head:order:/), to_producer: '*', exec_state: 'open' });

    await call('POST', '/api/test', { body: { clock: '2026-10-08T09:00:00Z' } });
    const yesterday = parse(await tool('brief', { day: '2026-10-07' }));
    expect(yesterday).toMatchObject({ date: '2026-10-07', decisions: [expect.objectContaining({ id: 'hermes:mail:anna', state: 'decided', decision: 'edited' })] });
  });
});

describe('refusals in the flow', () => {
  it('refuses a wrong verifier, a reused code (and signs out what it made), and an expired code', async () => {
    const wrong = await connect();
    await expect(exchangeAuthorization(headUrl(), { metadata: wrong.meta, clientInformation: wrong.client, authorizationCode: wrong.code, codeVerifier: 'x'.repeat(43), redirectUri: REDIRECT, resource: mcpUrl() })).rejects.toThrow();
    // A code is good for one try: the right verifier after a wrong one fails too.
    await expect(exchangeAuthorization(headUrl(), { metadata: wrong.meta, clientInformation: wrong.client, authorizationCode: wrong.code, codeVerifier: wrong.codeVerifier, redirectUri: REDIRECT, resource: mcpUrl() })).rejects.toThrow();

    const c = await connect();
    const first = await exchangeAuthorization(headUrl(), { metadata: c.meta, clientInformation: c.client, authorizationCode: c.code, codeVerifier: c.codeVerifier, redirectUri: REDIRECT, resource: mcpUrl() });
    await expect(exchangeAuthorization(headUrl(), { metadata: c.meta, clientInformation: c.client, authorizationCode: c.code, codeVerifier: c.codeVerifier, redirectUri: REDIRECT, resource: mcpUrl() })).rejects.toThrow();
    expect((await fetch(mcpUrl(), { method: 'POST', headers: { authorization: `Bearer ${first.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status).toBe(401);

    const late = await connect();
    await call('POST', '/api/test', { body: { clock: '2026-10-07T09:10:00Z' } });
    await expect(exchangeAuthorization(headUrl(), { metadata: late.meta, clientInformation: late.client, authorizationCode: late.code, codeVerifier: late.codeVerifier, redirectUri: REDIRECT, resource: mcpUrl() })).rejects.toThrow();
  });

  it('refuses an unregistered redirect URI without redirecting to it, and registers only https or loopback http', async () => {
    const c = await connect();
    const { authorizationUrl } = await startAuthorization(headUrl(), { metadata: c.meta, clientInformation: c.client, redirectUrl: 'https://evil.example/cb', scope: 'owner', state: 's', resource: mcpUrl() });
    const r = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
    const reg = async (redirect_uris: string[], extra: Record<string, unknown> = {}) => (await fetch(`${headUrl()}/api/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris, ...extra }) })).json();
    expect((await reg(['http://assistant.example/cb'])).error).toBe('invalid_redirect_uri');
    expect((await reg(['https://assistant.example/cb#frag'])).error).toBe('invalid_redirect_uri');
    expect((await reg(['http://127.0.0.1:8123/callback'])).client_id).toMatch(/^mcp_/);
    expect((await reg(['https://assistant.example/cb'], { token_endpoint_auth_method: 'client_secret_basic' })).error).toBe('invalid_client_metadata');
    expect((await reg(['https://assistant.example/cb'], { grant_types: ['implicit'] })).error).toBe('invalid_client_metadata');
    // No PKCE, no code: the request goes back with an error.
    const noPkce = new URL(`${headUrl()}/api/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: c.client.client_id, redirect_uri: REDIRECT, state: 's' })) noPkce.searchParams.set(k, v);
    const np = await fetch(noPkce, { redirect: 'manual' });
    expect(new URL(np.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });
});

describe('refresh and signing out', () => {
  it('rotates the refresh token; the old one then fails (and signs the assistant out, as a leaked token would)', async () => {
    const { meta, client, tokens: t } = await tokens();
    const next = await refreshAuthorization(headUrl(), { metadata: meta, clientInformation: client, refreshToken: t.refresh_token!, resource: mcpUrl() });
    expect(next.refresh_token).not.toBe(t.refresh_token);
    expect((await (await mcpClient(next.access_token)).listTools()).tools.length).toBe(8);
    await expect(refreshAuthorization(headUrl(), { metadata: meta, clientInformation: client, refreshToken: t.refresh_token!, resource: mcpUrl() })).rejects.toThrow();
    await expect(refreshAuthorization(headUrl(), { metadata: meta, clientInformation: client, refreshToken: next.refresh_token!, resource: mcpUrl() })).rejects.toThrow();
  });

  it('refuses a signed-out assistant’s refresh token and access token; a refresh token for another client is refused', async () => {
    const { meta, client, tokens: t } = await tokens();
    const other = await registerClient(headUrl(), { metadata: meta, clientMetadata: { client_name: 'Other', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } as never });
    await expect(refreshAuthorization(headUrl(), { metadata: meta, clientInformation: other as OAuthClientInformationFull, refreshToken: t.refresh_token!, resource: mcpUrl() })).rejects.toThrow();
    const device = (await call('GET', '/api/me/settings/devices', { auth: owner.auth })).body.devices.find((d: { platform: string }) => d.platform === 'mcp');
    expect((await call('DELETE', `/api/me/settings/devices/${device.id}`, { auth: owner.auth })).status).toBe(204);
    await expect(refreshAuthorization(headUrl(), { metadata: meta, clientInformation: client, refreshToken: t.refresh_token!, resource: mcpUrl() })).rejects.toThrow();
    expect((await fetch(mcpUrl(), { method: 'POST', headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(401);
  });
});

describe('two credential types, never mixed', () => {
  it('refuses a producer token and a web session on /api/mcp, and an access token on a producer route', async () => {
    const { tokens: t } = await tokens();
    const post = (authorization: string) => fetch(mcpUrl(), { method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await post(hermes)).status).toBe(401);
    const web = owner.auth.replace(/^Session /, '');
    expect((await post(`Bearer ${web}`)).status).toBe(401); // a sign-in session has no `owner` scope
    expect((await post(owner.auth)).status).toBe(401); // and not as Session either
    expect((await call('PUT', cardPath('hermes:x:1'), { auth: `Bearer ${t.access_token}`, body: card('hermes:x:1') })).status).toBe(401);
    expect((await call('GET', '/api/changes?after=0', { auth: `Bearer ${t.access_token}` })).status).toBe(401);
    // A web refresh token is not an OAuth refresh token, nor the other way round.
    expect((await call('POST', '/api/auth/refresh', { body: { refresh_token: t.refresh_token } })).status).toBe(401);
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
