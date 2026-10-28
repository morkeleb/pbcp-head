// Producer pairing (lib/settings/pairing.ts): the owner makes a code in Settings; an agent trades it at the public
// POST /api/pair for a token of its own. A failed attempt touches no code and counts against the rate limit; a code is
// burned only by its own use; a good code with a bad root
// does not; the route is rate-limited per address; a pairing is in the owner's record.

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cards } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

let owner: { auth: string; deviceId: string };
let ip = 0;
/** Each test pairs from its own address, so the per-address limit is the rate-limit test's alone. */
let address = '';
const me = (method: string, path: string, body?: unknown) => call(method, path, { auth: owner.auth, ...(body !== undefined ? { body } : {}) });
const pair = (body: unknown, headers: Record<string, string> = {}) => call('POST', '/api/pair', { body, headers: { 'x-real-ip': address, ...headers } });
const newCode = async () => (await me('POST', '/api/me/settings/pairing')).body as { id: string; code: string; say: string; api: string; expires_at: string };
const openCodes = async () => (await me('GET', '/api/me/settings/pairing')).body.codes as Array<{ id: string }>;
const submit = (token: string, root: string) =>
  call('PUT', cardPath(`${root}:x:1`), { auth: `Bearer ${token}`, body: card(`${root}:x:1`, { producer: root, kind: 'artifact' }) });

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z', rateLimits: null } });
  owner = await ownerSession(OWNER, 'laptop');
  address = `10.0.0.${++ip}`;
});
afterEach(() => call('POST', '/api/test', { body: { clock: null, rateLimits: null } }));

describe('POST /api/pair', () => {
  it('makes a code in two groups from an unambiguous alphabet, with the sentence to give the agent', async () => {
    const c = await newCode();
    expect(c.code).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    expect(c.api).toBe(`${headUrl()}/api`);
    expect(c.say).toBe(`Pair with ${headUrl()}/api, code ${c.code}.`);
    expect(c.expires_at).toBe('2026-10-07T09:10:00Z');
    expect(await openCodes()).toEqual([expect.objectContaining({ id: c.id })]);
    expect(JSON.stringify(await openCodes())).not.toContain(c.code.replace('-', ''));
  });

  it('takes the code as shown, XXX-XXX, and with the dash left out', async () => {
    const shown = await newCode();
    expect(shown.code).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    let r = await pair({ code: shown.code, root: 'with-dash' });
    expect(r.status).toBe(201);
    const typed = await newCode();
    r = await pair({ code: typed.code.replace('-', ''), root: 'without-dash' });
    expect(r.status).toBe(201);
    expect((await submit(r.body.token, 'without-dash')).status).toBe(201);
  });

  it('pairs once: the token submits a card, the row says paired, a second use fails', async () => {
    const c = await newCode();
    const r = await pair({ code: c.code.toLowerCase().replace('-', ' '), root: 'agent-7', name: 'Night agent' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ token: expect.stringMatching(/^pbcp_/), api: `${headUrl()}/api`, owner: OWNER, root: 'agent-7' });
    expect((await submit(r.body.token, 'agent-7')).status).toBe(201);
    const row = (await me('GET', '/api/me/settings/producers')).body.producers.find((p: { root: string }) => p.root === 'agent-7');
    expect(row.paired).toEqual({ name: 'Night agent', address, at: '2026-10-07T09:00:00Z' });
    expect(await openCodes()).toEqual([]);
    const again = await pair({ code: c.code, root: 'agent-8' });
    expect([again.status, again.body.error]).toEqual([400, 'invalid_code']);
  });

  it('records the pairing in the owner’s brief: a head:producer:<root> signal at log', async () => {
    const c = await newCode();
    await pair({ code: c.code, root: 'agent-7', name: 'Night agent' });
    const [row] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'head:producer:agent-7')));
    expect(row!.producerDoc).toMatchObject({ kind: 'signal', urgency: 'log', producer: 'head', title: 'Night agent paired as `agent-7`' });
    expect((row!.producerDoc as { body: string }).body).toContain(`Paired at 2026-10-07T09:00:00Z from ${address}`);
    expect(row!.delivery).toBe('log');
    // Without a name, the root names it.
    const d = await newCode();
    await pair({ code: d.code, root: 'agent-9' });
    const [nameless] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'head:producer:agent-9')));
    expect((nameless!.producerDoc as { title: string }).title).toBe('agent-9 paired as `agent-9`');
  });

  it('refuses an expired code', async () => {
    const c = await newCode();
    await call('POST', '/api/test', { body: { clock: '2026-10-07T09:10:00Z' } }); // the moment it expires
    const r = await pair({ code: c.code, root: 'agent-7' });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_code']);
    expect(Object.keys(r.body).sort()).toEqual(['error', 'message']);
  });

  it('refuses a wrong code with 400 invalid_code and nothing more, and leaves every real code usable', async () => {
    const real = await newCode();
    const other = await newCode();
    const wrong = await pair({ code: 'ZZZ-ZZZ', root: 'agent-7' });
    expect([wrong.status, wrong.body.error]).toEqual([400, 'invalid_code']);
    expect(wrong.body.message).not.toMatch(/expired|used|exist/i);
    expect(await openCodes()).toHaveLength(2); // a wrong attempt touches no code: it costs the caller one try
    expect((await pair({ code: real.code, root: 'agent-7' })).status).toBe(201);
    expect((await pair({ code: other.code, root: 'agent-8' })).status).toBe(201);
    // A used code is refused the same way, and burns nothing else.
    const third = await newCode();
    expect((await pair({ code: real.code, root: 'agent-9' })).body.error).toBe('invalid_code');
    expect(await openCodes()).toEqual([expect.objectContaining({ id: third.id })]);
  });

  it('answers a taken root with 409 root_taken, and a malformed one with 400 invalid_root, without burning the code', async () => {
    await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' });
    const c = await newCode();
    const taken = await pair({ code: c.code, root: 'hermes' });
    expect([taken.status, taken.body.error]).toEqual([409, 'root_taken']);
    for (const root of ['has:colon', '', 'head', 'x'.repeat(65)]) expect((await pair({ code: c.code, root })).body.error, root).toBe('invalid_root');
    expect(await openCodes()).toHaveLength(1);
    expect((await pair({ code: c.code, root: 'hermes-2' })).status).toBe(201);
  });

  it('holds the rate limit per address: 10 attempts an hour, then 429', async () => {
    for (let i = 0; i < 10; i++) expect((await pair({ code: 'ZZZ-ZZZ', root: 'x' })).status).toBe(400);
    const over = await pair({ code: 'ZZZ-ZZZ', root: 'x' });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toMatch(/^\d+$/);
    // Another address is counted apart.
    address = '10.9.9.9';
    expect((await pair({ code: 'ZZZ-ZZZ', root: 'x' })).status).toBe(400);
  });

  it('needs no credential, and takes none: a session (the owner’s side is Settings) or a producer token cannot pair', async () => {
    const c = await newCode();
    const bearer = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
    for (const authorization of [owner.auth, bearer]) {
      const r = await pair({ code: c.code, root: 'agent-7' }, { authorization });
      expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
    }
    expect(await openCodes()).toHaveLength(1); // not an attempt at the code
    expect((await pair({ code: c.code, root: 'agent-7' })).status).toBe(201);
  });

  it('cancels a code from Settings, and a producer token cannot make or list codes', async () => {
    const c = await newCode();
    expect((await me('DELETE', `/api/me/settings/pairing/${c.id}`)).status).toBe(204);
    expect((await pair({ code: c.code, root: 'agent-7' })).body.error).toBe('invalid_code');
    const bearer = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
    expect((await call('POST', '/api/me/settings/pairing', { auth: bearer })).status).toBe(401);
    expect((await call('GET', '/api/me/settings/pairing', { auth: bearer })).status).toBe(401);
  });
});

describe('the flow, described', () => {
  it('/llms.txt and /connect tell an agent to ask for a code, POST it with a root to /api/pair, and keep the token', async () => {
    const text = (await call('GET', '/llms.txt')).body as string;
    const api = `${headUrl()}/api`;
    expect(text).toContain('## Pairing: getting a token with a code');
    expect(text).toContain('1. Ask the owner for a pairing code.');
    expect(text).toContain('it is six characters shown as two groups of three (XXX-XXX); the dash is optional when entering. It is valid 10 minutes and works once.');
    expect(text).toContain(`to ${api}/pair: {"code": "<code>", "root": "<root>", "name": "<what you are>"}`);
    expect(text).toContain('Keep the token in the answer: it is shown this once.');
    expect(text).toContain('Use `api`, `owner` and the token as the three values');
    expect(text).toContain(`curl -s -X POST '${api}/pair'`);
    const html = (await call('GET', '/connect')).body as string;
    expect(html).toContain('data-pairing-steps');
    expect(html).toContain('Ask the owner for a pairing code.');
    expect(html).toContain('six characters shown as two groups of three (XXX-XXX); the dash is optional when entering');
    const doc = (await call('GET', '/api/openapi.json')).body;
    expect(doc.paths['/api/pair'].post.description).toContain('six characters shown as two groups of three (XXX-XXX); the dash is optional when entering');
  });
});
