// RFC 0.9 `sensitivity` on the head's surfaces: the owner's floors (§9), a `confirm` decision only after the person
// identified themselves again (§4.1, §4.5, §7.3, §7.4), the step-up that stamps the session, and the brief's parts that
// carry both sensitivities with a spoken paragraph that counts private entries (§4.1 `private`).

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionLog } from '../../db/schema';
import { enrollmentToken } from '../../lib/auth/enroll';
import { mintProducerToken } from '../../lib/auth/producer';
import { urgentPayload } from '../../lib/push/urgent';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';
import { headUrl } from './helpers';

let owner: { auth: string; deviceId: string };
let mail: string;
const clock = (at: string | null) => call('POST', '/api/test', { body: { clock: at } });
const me = (method: string, path: string, body?: unknown, auth = owner.auth) => call(method, path, { auth, ...(body !== undefined ? { body } : {}) });
const put = (id: string, extra: Record<string, unknown> = {}, auth = mail) => call('PUT', cardPath(id), { auth, body: card(id, extra) });
const effective = async (id: string, auth = owner.auth) => (await call('GET', `/api/me/cards/${encodeURIComponent(id)}`, { auth })).body.card.effective_sensitivity;
const seq = async () => (await me('GET', '/api/me/seq')).body.seq as number;
const logRows = async (id: string) => testDb().select().from(decisionLog).where(and(eq(decisionLog.headId, OWNER), eq(decisionLog.cardId, id)));

beforeEach(async () => {
  await resetHead();
  await clock('2026-10-07T09:00:00Z');
  owner = await ownerSession(OWNER, 'laptop');
  mail = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'mail' })}`;
});
afterEach(() => clock(null));

/** A passkey registered for the head (the enrolment ceremony), and the signed-in session it made. */
async function passkey() {
  const auth = new SoftAuthenticator(headUrl());
  const enroll = await enrollmentToken(OWNER);
  const opts = await call('POST', '/api/auth/passkey/register/options', { body: { enroll } });
  const r = await call('POST', '/api/auth/passkey/register', { body: { state: opts.body.state, response: auth.create(opts.body.options), platform: 'web', name: 'Laptop' } });
  expect(r.status).toBe(200);
  return { auth, session: `Session ${r.body.access_token}` };
}

/** The step-up on `session` with `auth`'s passkey: the status of the verify call. */
async function stepUp(session: string, auth: SoftAuthenticator) {
  const o = await call('POST', '/api/auth/passkey/step-up/options', { auth: session, body: {} });
  expect(o.status).toBe(200);
  return call('POST', '/api/auth/passkey/step-up', { auth: session, body: { state: o.body.state, response: auth.get(o.body.options) } });
}

describe('the owner’s floors (RFC 0.9 §9)', () => {
  it('raises a card by producer, by label and for every card, never lowers it, and covers cards already stored', async () => {
    expect((await put('mail:a:1', { labels: ['bank'] })).status).toBe(201);
    expect((await put('mail:a:2', { sensitivity: 'confirm' })).status).toBe(201);
    expect(await effective('mail:a:1')).toBe('normal');

    // Set after the card was stored: it is raised all the same (a floor is about exposure, not attention).
    const label = await me('PATCH', '/api/me/settings/labels/bank', { sensitivity_floor: 'confirm' });
    expect(label.body).toMatchObject({ label: 'bank', sensitivity_floor: 'confirm', ceiling: null });
    expect(await effective('mail:a:1')).toBe('confirm');
    // The card's own value never changes: as sent, absent stays absent (§5, C57).
    const stored = (await call('GET', `/api/me/cards/${encodeURIComponent('mail:a:1')}`, { auth: owner.auth })).body.card;
    expect(stored.sensitivity).toBeUndefined();

    // A lower floor never lowers a card that asked for more.
    const [token] = (await me('GET', '/api/me/settings/producers')).body.producers;
    expect((await me('PATCH', `/api/me/settings/producers/${token.id}`, { sensitivity_floor: 'private' })).body).toMatchObject({ root: 'mail', sensitivity_floor: 'private' });
    expect(await effective('mail:a:2')).toBe('confirm');
    await me('PATCH', '/api/me/settings/labels/bank', { sensitivity_floor: null });
    expect(await effective('mail:a:1')).toBe('private'); // the producer's floor now

    // For every card, the head's own included.
    await me('PATCH', `/api/me/settings/producers/${token.id}`, { sensitivity_floor: null });
    expect((await me('PATCH', '/api/me/settings', { sensitivity_floor: 'private' })).body.sensitivity_floor).toBe('private');
    expect(await effective('mail:a:1')).toBe('private');
    expect((await me('PATCH', '/api/me/settings', { sensitivity_floor: null })).body.sensitivity_floor).toBeNull();
    expect(await effective('mail:a:1')).toBe('normal');
    expect((await me('PATCH', '/api/me/settings', { sensitivity_floor: 'secret' })).status).toBe(400);
    expect((await me('PATCH', '/api/me/producers/mail', { sensitivity_floor: 'confirm' })).status).toBe(200);
    expect(await effective('mail:a:1')).toBe('confirm');
  });
});

describe('a confirm decision needs the person (RFC 0.9 §4.1, §7.3, §7.4)', () => {
  it('refuses every decision value without a recent re-identification, before anything is written', async () => {
    await put('mail:pay:1', { sensitivity: 'confirm', actions: [{ id: 'pay', label: 'Pay', default: true }, 'reject'] });
    await put('mail:task:1', { kind: 'task', sensitivity: 'confirm' });
    const before = await seq();
    for (const [id, body] of [
      ['mail:pay:1', { decision: 'pay' }],
      ['mail:pay:1', { decision: 'dismissed' }],
      ['mail:pay:1', { decision: 'edited', edited_proposal: 'Pay half.' }],
      ['mail:task:1', { decision: 'done' }],
    ] as const) {
      const r = await me('POST', `/api/me/cards/${encodeURIComponent(id)}/decision`, body);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: 'reauthentication_required', window_seconds: 300 });
      expect(r.body.message).toMatch(/5 minutes/);
    }
    // No counter bump, no card change, no decision-log row.
    expect(await seq()).toBe(before);
    expect((await call('GET', `/api/me/cards/${encodeURIComponent('mail:pay:1')}`, { auth: owner.auth })).body.card.state).toBe('open');
    expect(await logRows('mail:pay:1')).toEqual([]);
    // The RFC's own path for the owner's decide (§7.3) is the same owner route, with the same check.
    expect((await call('POST', `/api/cards/${encodeURIComponent('mail:pay:1')}/decision`, { auth: owner.auth, body: { decision: 'pay' } })).status).toBe(403);
    // Snooze, acknowledge and seen are not decisions.
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('mail:pay:1')}/snooze`, { preset: 'tomorrow' })).status).toBe(200);
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('mail:pay:1')}/seen`)).status).toBe(200);
    await put('mail:note:1', { kind: 'artifact', sensitivity: 'confirm' });
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('mail:note:1')}/ack`)).status).toBe(200);
  });

  it('records it within five minutes of a passkey step-up on the same session, and not after; a producer never decides', async () => {
    await put('mail:pay:1', { sensitivity: 'confirm' });
    await put('mail:pay:2', { sensitivity: 'confirm' });
    const { auth } = await passkey();
    const r = await stepUp(owner.auth, auth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ reauthenticated_at: '2026-10-07T09:00:00.000Z', window_seconds: 300 });
    // The step-up rotates nothing: the same access token goes on working.
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('mail:pay:1')}/decision`, { decision: 'approve' })).status).toBe(200);
    expect(await logRows('mail:pay:1')).toHaveLength(1);
    await clock('2026-10-07T09:05:01Z');
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('mail:pay:2')}/decision`, { decision: 'approve' })).status).toBe(403);
    // Another session is not stamped by this one's step-up.
    await stepUp(owner.auth, auth);
    const other = await ownerSession(OWNER, 'phone');
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('mail:pay:2')}/decision`, { decision: 'approve' }, other.auth)).status).toBe(403);
    // A producer token is never a session (§7.3): 401, the confirm rule never reached.
    expect((await call('POST', `/api/me/cards/${encodeURIComponent('mail:pay:2')}/decision`, { auth: mail, body: { decision: 'approve' } })).status).toBe(401);
  });

  it('counts a passkey sign-in as identifying, but never a refresh; and refuses a step-up with another session’s state or a foreign passkey', async () => {
    await put('mail:pay:1', { sensitivity: 'confirm' });
    await put('mail:pay:2', { sensitivity: 'confirm' });
    const { auth, session } = await passkey();
    expect((await call('POST', `/api/me/cards/${encodeURIComponent('mail:pay:1')}/decision`, { auth: session, body: { decision: 'approve' } })).status).toBe(200);
    await clock('2026-10-07T09:10:00Z');
    expect((await call('POST', `/api/me/cards/${encodeURIComponent('mail:pay:2')}/decision`, { auth: session, body: { decision: 'approve' } })).status).toBe(403);

    const o = await call('POST', '/api/auth/passkey/step-up/options', { auth: owner.auth, body: {} });
    const other = await ownerSession(OWNER, 'phone');
    expect((await call('POST', '/api/auth/passkey/step-up', { auth: other.auth, body: { state: o.body.state, response: auth.get(o.body.options) } })).status).toBe(400);
    const stranger = new SoftAuthenticator(headUrl());
    expect((await call('POST', '/api/auth/passkey/step-up', { auth: owner.auth, body: { state: o.body.state, response: stranger.get(o.body.options) } })).status).toBe(401);
    // No session at all: the step-up is the owner's.
    expect((await call('POST', '/api/auth/passkey/step-up/options', { body: {} })).status).toBe(401);
  });

  it('applies to a normal card an owner’s floor raised to confirm', async () => {
    await put('mail:wire:1', { labels: ['bank'] });
    await me('PATCH', '/api/me/settings/labels/bank', { sensitivity_floor: 'confirm' });
    const r = await me('POST', `/api/me/cards/${encodeURIComponent('mail:wire:1')}/decision`, { decision: 'approve' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('reauthentication_required');
    // A private card (not confirm) is decided as any card.
    await put('mail:wire:2', { sensitivity: 'private' });
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('mail:wire:2')}/decision`, { decision: 'approve' })).status).toBe(200);
  });
});

describe('the brief’s parts and the spoken paragraph (RFC 0.9 §4.1 private)', () => {
  it('carries both sensitivities on each entry and on each card, and spoken=1 counts private entries instead of naming them', async () => {
    await put('mail:a:1', { title: 'Reply to Anna', summary: 'About the invoice.' });
    await put('mail:a:2', { title: 'Mortgage offer', summary: 'Rate 3.1%.', sensitivity: 'private' });
    await put('mail:a:3', { title: 'Wire to the lawyer', summary: 'DKK 40,000.', labels: ['bank'] });
    await me('PATCH', '/api/me/settings/labels/bank', { sensitivity_floor: 'confirm' });

    const b = (await me('GET', '/api/me/brief')).body;
    const entries = Object.fromEntries(b.daily_paragraph.parts.decisions.map((e: { id: string }) => [e.id, e]));
    expect(entries['mail:a:1']).toMatchObject({ sensitivity: 'normal', effective_sensitivity: 'normal' });
    expect(entries['mail:a:2']).toMatchObject({ sensitivity: 'private', effective_sensitivity: 'private' });
    expect(entries['mail:a:3']).toMatchObject({ sensitivity: 'normal', effective_sensitivity: 'confirm' });
    expect(b.decisions.map((c: { id: string; effective_sensitivity: string }) => [c.id, c.effective_sensitivity]).sort()).toEqual([
      ['mail:a:1', 'normal'], ['mail:a:2', 'private'], ['mail:a:3', 'confirm'],
    ]);
    // Inside the session the HTML paragraph is unchanged: every entry named.
    expect(b.daily_paragraph.html).toMatch(/Mortgage offer/);
    expect(b.daily_paragraph.text).toBeUndefined();

    const s = (await call('GET', '/api/me/brief?spoken=1', { auth: owner.auth })).body.daily_paragraph;
    expect(s.text).toMatch(/^3 decisions: Reply to Anna — About the invoice; and 2 private decisions\./);
    expect(s.text).not.toMatch(/Mortgage|Wire|3\.1|40,000/);
    expect(s.html).not.toMatch(/Mortgage|Wire/);
  });
});

describe('push payloads (RFC 0.9 §4.1 private)', () => {
  it('names a private or confirm card by producer and kind only, and opens the brief', () => {
    const c = { id: 'mail:a:2', title: 'Mortgage offer', summary: 'Rate 3.1%.', body: 'Rate 3.1%.', kind: 'decision' as const, producer: 'mail' };
    expect(urgentPayload(c, 'private')).toEqual({ title: 'Brief', body: 'A private decision from mail', data: { url: '/brief' }, tag: 'pbcp-card:mail:a:2' });
    expect(JSON.stringify(urgentPayload(c, 'confirm', 'Mail agent'))).not.toMatch(/Mortgage|3\.1/);
    expect(urgentPayload(c, 'confirm', 'Mail agent').body).toBe('A private decision from Mail agent');
    expect(urgentPayload(c, 'normal')).toMatchObject({ title: 'Mortgage offer', body: 'Rate 3.1%.', data: { url: '/card/mail%3Aa%3A2' } });
  });
});
