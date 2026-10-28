// /api/me/settings/*: the owner's settings over the human API, Session only. Producer tokens are minted and revoked
// here (lib/settings/producers.ts, as the scripts do); the snippets come from lib/settings/snippets.ts.

import { HeadClient } from '@pbcp/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { snippets, TOKEN_PLACEHOLDER } from '../../lib/settings/snippets';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

let owner: { auth: string; deviceId: string };
const me = (method: string, path: string, body?: unknown) => call(method, path, { auth: owner.auth, ...(body !== undefined ? { body } : {}) });

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: null } });
  owner = await ownerSession(OWNER, 'laptop');
});

describe('this head', () => {
  it('reports the owner id, the head URL a producer is given, and the protocol, as GET / does', async () => {
    const r = await me('GET', '/api/me/settings/head');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ owner: OWNER, url: `${headUrl()}/api`, protocol: 'pbcp/1', extensions: ['orders'], render: { mermaid: ['core', 'extended'] } });
    // The URL is the one a producer's client is configured with: it describes the head.
    const token = (await me('POST', '/api/me/settings/producers', { root: 'hermes' })).body.token;
    expect((await new HeadClient({ baseUrl: r.body.url, token }).describe()).owner).toBe(OWNER);
  });
});

describe('producer tokens', () => {
  it('mints a token through the route that PUTs a card; lists it with created and last used; never returns it again', async () => {
    const r = await me('POST', '/api/me/settings/producers', { root: 'n8n' });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^pbcp_/);
    expect(r.body.producer).toMatchObject({ root: 'n8n', ceiling: 'brief', executor: false, last_used_at: null });
    const put = await call('PUT', cardPath('n8n:daily:2026-10-07'), { auth: `Bearer ${r.body.token}`, body: card('n8n:daily:2026-10-07', { producer: 'n8n', kind: 'artifact' }) });
    expect(put.status).toBe(201);
    const list = (await me('GET', '/api/me/settings/producers')).body.producers;
    expect(list).toEqual([expect.objectContaining({ id: r.body.producer.id, root: 'n8n', last_used_at: expect.any(String) })]);
    expect(JSON.stringify(list)).not.toContain(r.body.token);
  });

  it('revokes a token behind its id: its producer gets 401 from then on', async () => {
    const { body } = await me('POST', '/api/me/settings/producers', { root: 'n8n' });
    expect((await me('DELETE', `/api/me/settings/producers/${body.producer.id}`)).status).toBe(204);
    const put = await call('PUT', cardPath('n8n:daily:1'), { auth: `Bearer ${body.token}`, body: card('n8n:daily:1', { producer: 'n8n', kind: 'artifact' }) });
    expect(put.status).toBe(401);
    expect((await me('GET', '/api/me/settings/producers')).body.producers).toEqual([]);
    expect((await me('DELETE', `/api/me/settings/producers/${body.producer.id}`)).status).toBe(404);
    // Revoked, the root is free again.
    expect((await me('POST', '/api/me/settings/producers', { root: 'n8n' })).status).toBe(201);
  });

  it('validates the root by the §5 id grammar, keeps `head` for the head, and refuses a root that has a live token', async () => {
    for (const root of ['', 'has:colon', 'has space', 'under_score', 'é', 'x'.repeat(65)]) {
      const r = await me('POST', '/api/me/settings/producers', { root });
      expect([r.status, r.body.error], JSON.stringify(root)).toEqual([400, 'invalid_root']);
    }
    expect((await me('POST', '/api/me/settings/producers', { root: 'head' })).body.error).toBe('invalid_root');
    expect((await me('POST', '/api/me/settings/producers', { root: 'Todo-ist2' })).status).toBe(201);
    const again = await me('POST', '/api/me/settings/producers', { root: 'Todo-ist2' });
    expect([again.status, again.body.error]).toEqual([409, 'root_in_use']);
    expect((await me('POST', '/api/me/settings/producers', { root: 'Todo-ist2', instance: 'laptop' })).status).toBe(201); // a second installation
  });

  it('sets a producer’s ceiling from a token’s row: every live token of its root', async () => {
    const { body } = await me('POST', '/api/me/settings/producers', { root: 'cal' });
    const r = await me('PATCH', `/api/me/settings/producers/${body.producer.id}`, { ceiling: 'immediate' });
    expect(r.body).toMatchObject({ root: 'cal', ceiling: 'immediate' });
    expect((await me('PATCH', `/api/me/settings/producers/${body.producer.id}`, { ceiling: 'loud' })).status).toBe(400);
  });
});

describe('connect a producer: snippets', () => {
  it('fills curl, n8n and Hermes with the head URL, the owner id and the root; the route leaves a placeholder for the token', async () => {
    const r = await me('GET', '/api/me/settings/snippets?root=n8n');
    expect(r.status).toBe(200);
    expect(r.body.token).toBe(TOKEN_PLACEHOLDER);
    for (const key of ['curl', 'n8n', 'hermes'] as const) {
      expect(r.body[key], key).toContain(`${headUrl()}/api`);
      expect(r.body[key], key).toContain(TOKEN_PLACEHOLDER);
    }
    expect(r.body.curl).toContain(`"to_person": "${OWNER}"`);
    expect(r.body.curl).toContain(`PUT "${headUrl()}/api/cards/n8n:hello:first"`);
    const node = JSON.parse(r.body.n8n).nodes[0];
    expect(node).toMatchObject({ type: 'n8n-nodes-base.httpRequest', parameters: { method: 'PUT' } });
    expect(node.parameters.url).toBe(`=${headUrl()}/api/cards/n8n:daily:{{ $now.toFormat('yyyy-MM-dd') }}`);
    expect(node.parameters.headerParameters.parameters[0]).toEqual({ name: 'Authorization', value: `Bearer ${TOKEN_PLACEHOLDER}` });
    expect(node.parameters.jsonBody).toContain(`"to_person": "${OWNER}"`);
    expect(r.body.hermes).toContain(`export PBCP_HEAD_URL=${headUrl()}/api`);
    expect(r.body.hermes).toContain('"args": [\n');
    expect(r.body.hermes).toContain('@pbcp/mcp');
    expect((await me('GET', '/api/me/settings/snippets?root=a:b')).status).toBe(400);
  });

  it('gives a curl snippet that, run with a real token, stores its card', async () => {
    const { token } = (await me('POST', '/api/me/settings/producers', { root: 'shell' })).body;
    const s = snippets({ url: `${headUrl()}/api`, owner: OWNER, root: 'shell', token });
    const body = s.curl.slice(s.curl.indexOf('{'), s.curl.lastIndexOf('}') + 1).replace('$(date -u +%Y-%m-%dT%H:%M:%SZ)', '2026-10-07T09:00:00Z');
    const url = /PUT "([^"]+)"/.exec(s.curl)![1]!;
    const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    expect(res.status).toBe(201);
  });
});

describe('devices', () => {
  it('lists the devices with this one marked, signs one out, and prints an enrolment link', async () => {
    const phone = await ownerSession(OWNER, 'phone');
    const list = (await me('GET', '/api/me/settings/devices')).body.devices;
    expect(list.map((d: { name: string; current: boolean }) => [d.name, d.current]).sort()).toEqual([['laptop', true], ['phone', false]]);
    expect((await me('DELETE', `/api/me/settings/devices/${phone.deviceId}`)).status).toBe(204);
    expect((await call('GET', '/api/me/brief', { auth: phone.auth })).status).toBe(401);
    const e = await me('POST', '/api/me/settings/enrolment');
    expect(e.status).toBe(201);
    expect(e.body.url).toMatch(new RegExp(`^${headUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/signin\\?enroll=`));
    // The link works: it lets a new passkey's ceremony start for this head.
    const enroll = decodeURIComponent(e.body.url.split('enroll=')[1]);
    expect((await call('POST', '/api/auth/passkey/register/options', { body: { enroll } })).status).toBe(200);
  });
});

describe('two credential types, never mixed', () => {
  it('refuses a producer token on every /api/me/settings route, and takes no session on a producer route', async () => {
    const bearer = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/me/settings'],
      ['GET', '/api/me/settings/head'],
      ['GET', '/api/me/settings/producers'],
      ['POST', '/api/me/settings/producers', { root: 'sneaky' }],
      ['PATCH', '/api/me/settings/producers/0000000000000000', { ceiling: 'immediate' }],
      ['DELETE', '/api/me/settings/producers/0000000000000000'],
      ['GET', '/api/me/settings/labels'],
      ['PATCH', '/api/me/settings/labels/x', { ceiling: 'log' }],
      ['GET', '/api/me/settings/devices'],
      ['DELETE', '/api/me/settings/devices/x'],
      ['POST', '/api/me/settings/enrolment'],
      ['GET', '/api/me/settings/snippets'],
    ];
    for (const [method, path, body] of routes) {
      const r = await call(method, path, { auth: bearer, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect((await me('GET', '/api/me/settings/producers')).body.producers.map((p: { root: string }) => p.root)).toEqual(['hermes']); // nothing minted
    // And the other way: a session is no producer credential.
    expect((await call('PUT', cardPath('hermes:x:1'), { auth: owner.auth, body: card('hermes:x:1') })).status).toBe(401);
  });
});
