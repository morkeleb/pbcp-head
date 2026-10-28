// The human API against its contract: every /api/me route (and GET /) is called with real data, and every
// response, success or refusal, is validated against packages/api-types/openapi.json — the document the phone's
// client is generated from — not against the Zod schemas it was made from. Responses are strict there
// (`additionalProperties: false` outside the card), so a field the document does not name fails too.

import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';

const doc = JSON.parse(readFileSync(join(process.cwd(), 'packages/api-types/openapi.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(doc, 'api');

const templates = Object.keys(doc.paths).map((t) => ({ t, re: new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`) }));
const violations: string[] = [];
const covered = new Set<string>();

/** Validates one response against the operation's response for that status. */
function check(method: string, url: string, res: { status: number; body: unknown; headers: Headers }) {
  const path = url.split('?')[0]!;
  const t = templates.find((x) => x.re.test(path))?.t;
  const op = t && doc.paths[t][method.toLowerCase()];
  const where = `${method} ${url} → ${res.status}`;
  if (!op) return void violations.push(`${where}: no such operation in the document`);
  const r = op.responses[String(res.status)];
  if (!r) return void violations.push(`${where}: status not documented`);
  covered.add(`${method} ${t} ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  const media = r.content && Object.keys(r.content)[0];
  if (!media) return void (res.body !== null && res.body !== '' && violations.push(`${where}: a body where none is documented`));
  if (media !== 'application/json') {
    if (!type.startsWith(media.replace('*', ''))) violations.push(`${where}: content-type ${type}, documented ${media}`);
    return;
  }
  if (!type.startsWith('application/json')) return void violations.push(`${where}: content-type ${type}, documented application/json`);
  const schema = r.content[media].schema;
  const validate = ajv.compile({ $ref: `api${schema.$ref}` });
  if (!validate(res.body)) for (const e of validate.errors!) violations.push(`${where}: ${e.instancePath || '/'} ${e.message}${e.params && 'additionalProperty' in e.params ? ` (${e.params.additionalProperty})` : ''}`);
}

let owner: { auth: string; deviceId: string };
let phone: { auth: string; deviceId: string };
let hermes: string;
async function api(method: string, url: string, body?: unknown, auth: string | null = owner.auth) {
  const res = await call(method, url, { ...(auth ? { auth } : {}), ...(body !== undefined ? { body } : {}), headers: { 'x-timezone': 'Europe/Copenhagen' } });
  check(method, url, res);
  return res;
}
const enc = encodeURIComponent;

beforeAll(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z', syncPageSize: null } });
  owner = await ownerSession();
  phone = await ownerSession(OWNER, 'phone');
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', ceiling: 'immediate', executor: true })}`;
  await mintProducerToken(testDb(), { headId: OWNER, root: 'cal', instance: 'laptop' });
  const put = (id: string, extra: Record<string, unknown> = {}) => call('PUT', cardPath(id), { auth: hermes, body: card(id, extra) });
  await put('hermes:gmail:1', { thread: 't1', references: ['hermes:gmail:2', 'other:x:1'], source: { url: 'https://mail.example/1', label: 'Mail' } });
  await put('hermes:gmail:2', { kind: 'artifact', thread: 't1', urgency: 'immediate', body: 'A diagram:\n\n```mermaid\npie\n  "a": 1\n```\n\n![x](https://example.com/a.png)', 'x-extra': { any: 'thing' } });
  await put('hermes:gmail:3', { actions: [{ id: 'friday', label: 'Friday', body: 'Needs **Anna**.', default: true }, 'reject'] });
  await put('hermes:gmail:4', { supersedes: 'hermes:gmail:1' });
  await put('hermes:gmail:5', { kind: 'signal', urgency: 'log' });
});

describe('every /api/me response matches packages/api-types/openapi.json', () => {
  it('reads', async () => {
    await api('GET', '/', undefined, null);
    await api('GET', '/api/me');
    await api('GET', '/api/me/settings');
    await api('PATCH', '/api/me/settings', { display_name: 'Morten', timezone: 'Europe/Copenhagen' });
    await api('PATCH', '/api/me/settings', { timezone: null });
    await api('GET', '/api/me/brief');
    await api('GET', '/api/me/seq');
    await api('GET', '/api/me/cards?date=2026-10-07');
    await api('GET', '/api/me/cards?since=2026-10-01T00:00:00Z&limit=2');
    await api('GET', `/api/me/cards/${enc('hermes:gmail:4')}`);
    await api('GET', `/api/me/cards/${enc('hermes:gmail:1')}`);
    await api('GET', `/api/me/cards/${enc('hermes:gmail:2')}`);
    await api('GET', '/api/me/producers');
    await api('PATCH', '/api/me/producers/hermes', { ceiling: 'brief' });
    await api('PATCH', '/api/me/settings/labels/billing-revamp', { ceiling: 'log' });
    await api('GET', '/api/me/settings/labels');
    await api('PATCH', '/api/me/settings/labels/Not_A_Label', { ceiling: 'log' }); // 400
    await api('GET', '/api/me/devices');
    await api('GET', '/api/me/settings/head');
    const minted = await api('POST', '/api/me/settings/producers', { root: 'n8n' });
    await api('POST', '/api/me/settings/producers', { root: 'n8n' }); // 409
    await api('GET', '/api/me/settings/producers');
    await api('PATCH', `/api/me/settings/producers/${minted.body.producer.id}`, { ceiling: 'log' });
    await api('DELETE', `/api/me/settings/producers/${minted.body.producer.id}`);
    await api('GET', '/api/me/settings/snippets?root=n8n');
    const code = await api('POST', '/api/me/settings/pairing');
    await api('GET', '/api/me/settings/pairing');
    await api('POST', '/api/pair', { code: code.body.code, root: 'hermes' }, null); // 409: hermes has a token
    await api('POST', '/api/pair', { code: code.body.code, root: 'paired-agent', name: 'An agent' }, null);
    await api('POST', '/api/pair', { code: code.body.code, root: 'paired-agent' }, null); // 400: used
    const other = await api('POST', '/api/me/settings/pairing');
    await api('DELETE', `/api/me/settings/pairing/${other.body.id}`);
    await api('DELETE', `/api/me/settings/pairing/${other.body.id}`); // 404
    await api('GET', '/api/me/settings/devices');
    await api('POST', '/api/me/settings/enrolment');
    await api('DELETE', '/api/me/settings/devices/nope'); // 404
    await api('GET', '/api/push/key', undefined, null);
    await api('POST', '/api/invite', { email: 'contract@example.com' }, null);
    await api('POST', '/api/invite', { email: 'nope' }, null); // 400
    const invites = (await api('GET', '/api/me/settings/invites')).body.requests;
    await api('DELETE', `/api/me/settings/invites/${invites[0].id}`);
    await api('DELETE', `/api/me/settings/invites/${invites[0].id}`); // 404
    const p256dh = createECDH('prime256v1');
    p256dh.generateKeys();
    await api('POST', '/api/me/settings/push', { endpoint: 'https://push.example/send/abc', expirationTime: null, keys: { p256dh: p256dh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
    await api('PATCH', `/api/me/settings/devices/${owner.deviceId}`, { daily_notification: { enabled: true, time: '07:15' } });
    await api('PATCH', `/api/me/settings/devices/${owner.deviceId}`, { daily_notification: { time: '07:10' } }); // 400
    await api('PATCH', `/api/me/settings/devices/${phone.deviceId}`, { daily_notification: { enabled: true } }); // 403 not_this_device
    await api('PATCH', '/api/me/settings/devices/nope', { daily_notification: { enabled: true } }); // 404
    await api('DELETE', '/api/me/settings/push');
    await api('POST', '/api/me/visit', {});
    await api('POST', '/api/me/visit', { seq: 1 });
  });

  it('owner actions', async () => {
    await api('POST', `/api/me/cards/${enc('hermes:gmail:2')}/seen`);
    await api('POST', `/api/me/cards/${enc('hermes:gmail:2')}/ack`);
    await api('POST', `/api/me/cards/${enc('hermes:gmail:5')}/snooze`, { preset: 'tomorrow' });
    await api('POST', `/api/me/cards/${enc('hermes:gmail:5')}/snooze`, { until: '2026-10-09T06:00:00Z' });
    await api('POST', `/api/me/cards/${enc('hermes:gmail:5')}/unsnooze`);
    await api('POST', `/api/me/cards/${enc('hermes:gmail:3')}/decision`, { decision: 'friday', comment: 'ok' });
    await api('POST', `/api/me/cards/${enc('hermes:gmail:3')}/decision`, { decision: 'reject' }); // 409
    await api('POST', `/api/me/cards/${enc('hermes:gmail:3')}/snooze`, { preset: 'tonight' }); // 409
  });

  it('orders, with progress, an outcome and a late result', async () => {
    const o = (await api('POST', '/api/me/orders', { to_producer: '*', title: 'Book the dentist', body: 'Any **weekday** morning.' })).body;
    const k = o.id.split(':')[2];
    await call('POST', `${cardPath(o.id)}/claim`, { auth: hermes, body: { lease_seconds: 600 } });
    const progress = `hermes:order:${k}:progress-1-1`;
    await call('PUT', cardPath(progress), { auth: hermes, body: card(progress, { kind: 'signal', urgency: 'log', thread: o.id, title: 'Form found' }) });
    const out = (n: number, result: string) => {
      const id = `hermes:order:${k}:outcome-${n}`;
      return call('PUT', cardPath(id), { auth: hermes, body: card(id, { kind: 'signal', title: 'Booked', thread: o.id, references: [o.id], 'orders.claim_seq': n, 'orders.result': result }) });
    };
    await out(1, 'done');
    await out(2, 'failed'); // no such claim: stored, stale, a late result in the brief
    await api('GET', '/api/me/orders');
    await api('GET', `/api/me/cards/${enc(o.id)}`);
    await api('GET', `/api/me/cards/${enc(`hermes:order:${k}:outcome-1`)}`);
    await api('GET', '/api/me/brief');
    const gone = (await api('POST', '/api/me/orders', { to_producer: 'nobody', title: 'Water the plants' })).body;
    await api('POST', `/api/me/cards/${enc(gone.id)}/decision`, { decision: 'dismissed' });
  });

  it('refusals carry the error body', async () => {
    await api('GET', '/api/me', undefined, null); // 401
    await api('GET', '/api/me/brief', undefined, hermes); // 401: a producer token
    await api('GET', `/api/me/cards/${enc('hermes:none:1')}`); // 404
    await api('POST', `/api/me/cards/${enc('hermes:none:1')}/seen`); // 404
    await api('GET', '/api/me/cards?date=yesterday'); // 400
    await api('PATCH', '/api/me/settings', { timezone: 'Mars/Olympus' }); // 400
    await api('POST', `/api/me/cards/${enc('hermes:gmail:5')}/snooze`, { until: '2026-10-09T08:00:00+02:00' }); // 400 invalid_snooze
    await api('POST', `/api/me/cards/${enc('hermes:gmail:5')}/decision`, { nope: true }); // 400
    await api('POST', '/api/me/orders', { title: 'no recipient' }); // 400
    await api('POST', '/api/me/orders', { to_producer: '*', title: 'x', urgency: 'loud' }); // 400
    await api('PATCH', '/api/me/producers/nobody', { ceiling: 'log' }); // 404
    await api('PATCH', '/api/me/producers/hermes', { revoked: false }); // 400
    await api('POST', '/api/me/visit', { seq: -1 }); // 400
    await api('DELETE', '/api/me/devices/nope'); // 404
    await api('GET', `/api/me/svg/${'0'.repeat(64)}`, undefined, null); // 404
    await api('GET', '/api/me/img?u=https%3A%2F%2Fexample.com%2Fa.png&s=bad', undefined, null); // 403
    const other = await ownerSession(OWNER, 'old phone');
    await api('DELETE', `/api/me/devices/${other.deviceId}`); // 204
  });

  it('found no response the document does not describe', () => {
    expect(violations).toEqual([]);
  });

  it('exercised every documented operation', () => {
    const ops = Object.entries(doc.paths).flatMap(([t, item]) => Object.keys(item as object).map((m) => `${m.toUpperCase()} ${t}`));
    const hit = new Set([...covered].map((c) => c.split(' ').slice(0, 2).join(' ')));
    expect(ops.filter((o) => !hit.has(o) && o !== 'GET /api/me/svg/{hash}' && o !== 'GET /api/me/img')).toEqual([]);
  });
});
