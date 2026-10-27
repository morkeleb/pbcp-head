import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cards } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';

let hermes: string;
let cal: string;
let mail: string;
let owner: { auth: string };
const clock = (at: string) => call('POST', '/api/test', { body: { clock: at } });
const give = async (to: string, title = 'Book the dentist') => (await call('POST', '/api/me/orders', { auth: owner.auth, body: { to_producer: to, title, body: 'Any weekday morning.' } })).body;
const claim = (auth: string, id: string, lease: unknown = 60) => call('POST', `${cardPath(id)}/claim`, { auth, body: { lease_seconds: lease } });
/** An executor's outcome, under its per-claim id `<root>:order:<ulid>:outcome-<claim_seq>` (A.3). */
const outcomeId = (root: string, order: string, claimSeq: number) => `${root}:order:${ulid(order)}:outcome-${claimSeq}`;
const outcome = (auth: string, root: string, order: string, claimSeq: number, extra: Record<string, unknown> = {}) => {
  const id = outcomeId(root, order, claimSeq);
  return call('PUT', cardPath(id), { auth, body: card(id, { kind: 'signal', title: 'Done', thread: order, references: [order], 'orders.claim_seq': claimSeq, 'orders.result': 'done', ...extra }) });
};
const row = async (id: string) => (await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, id))))[0]!;
const ulid = (id: string) => id.split(':')[2]!;

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z', syncPageSize: null } });
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', executor: true })}`;
  cal = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'cal', executor: true })}`;
  mail = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'mail' })}`;
  owner = await ownerSession();
});

describe('POST /api/cards/{id}/claim', () => {
  it('two executors racing for one order: exactly one lease', async () => {
    const o = await give('*');
    const rs = await Promise.all([claim(hermes, o.id), claim(cal, o.id), claim(hermes, o.id), claim(cal, o.id)]);
    const winners = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.claimed_by));
    expect(winners.size).toBe(1);
    for (const r of rs) {
      if (r.status === 200) expect(r.body).toMatchObject({ id: o.id, exec_state: 'claimed', claim_seq: 1 });
      else expect(r).toMatchObject({ status: 409, body: { error: 'lease_held', message: expect.any(String), order: { id: o.id, exec_state: 'claimed' } } });
    }
  });

  it('a renewal keeps claim_seq; only a new claim increments it', async () => {
    const o = await give('*');
    expect((await claim(hermes, o.id, 60)).body).toMatchObject({ claim_seq: 1, claim_expires_at: '2026-10-07T09:01:00Z' });
    await clock('2026-10-07T09:00:30Z');
    expect((await claim(hermes, o.id, 60)).body).toMatchObject({ claim_seq: 1, claim_expires_at: '2026-10-07T09:01:30Z' });
    await clock('2026-10-07T09:02:00Z');
    expect((await claim(cal, o.id, 60)).body).toMatchObject({ claimed_by: 'cal', claim_seq: 2 });
    expect((await claim(cal, o.id, 60)).body).toMatchObject({ claimed_by: 'cal', claim_seq: 2 });
  });

  it('refuses a terminal order with 410 order_terminal and the order, keeping the expiry it evaluated', async () => {
    const o = await give('*');
    await claim(hermes, o.id);
    await call('POST', `/api/me/cards/${encodeURIComponent(o.id)}/decision`, { auth: owner.auth, body: { decision: 'dismissed' } });
    const r = await claim(hermes, o.id);
    expect(r).toMatchObject({ status: 410, body: { error: 'order_terminal', message: expect.any(String), order: { id: o.id, exec_state: 'cancelled' } } });
    expect(r.body.order).not.toHaveProperty('wildcard_eligible');
    expect(r.body.order.change_seq).toBe((await row(o.id)).changeSeq);
  });

  it('is 404 for a card that is not an order and for an order the caller cannot read', async () => {
    await call('PUT', cardPath('mail:inbox:1'), { auth: mail, body: card('mail:inbox:1') });
    expect(await claim(mail, 'mail:inbox:1')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    const named = await give('mail');
    expect((await claim(hermes, named.id)).status).toBe(404);
    expect((await claim(mail, named.id)).status).toBe(200); // a named order reaches a non-executor (OPEN 21)
  });

  it('refuses a bad lease with 400 invalid_lease, a bad body, and a session credential', async () => {
    const o = await give('*');
    for (const lease of [0, -5, 1.5, 'soon', null, 86_401]) {
      expect(await claim(hermes, o.id, lease), String(lease)).toMatchObject({ status: 400, body: { error: 'invalid_lease' } });
    }
    expect((await row(o.id)).execState).toBe('open');
    expect((await call('POST', `${cardPath(o.id)}/claim`, { auth: hermes, body: '{', type: 'application/json' })).body.error).toBe('malformed_json');
    expect((await claim(owner.auth, o.id)).status).toBe(401);
  });

  it('a producer cannot submit an order or write under head:', async () => {
    expect((await call('PUT', cardPath('hermes:order:x'), { auth: hermes, body: { ...card('hermes:order:x'), kind: 'order' } })).body.error).toBe('unsupported_kind');
    expect((await call('PUT', cardPath('head:order:x'), { auth: hermes, body: card('head:order:x', { producer: 'head' }) })).status).toBe(403);
  });
});

describe('expiry and sync', () => {
  it('a lapsed lease returns the order to open with a new change_seq the next time anyone syncs', async () => {
    const o = await give('*');
    const claimed = await claim(hermes, o.id, 60);
    await clock('2026-10-07T09:01:00Z');
    const page = await call('GET', `/api/changes?after=${claimed.body.change_seq}`, { auth: cal });
    expect(page.body.changes).toEqual([{ seq: claimed.body.change_seq + 1, card: expect.objectContaining({ id: o.id, exec_state: 'open', claim_seq: 1 }) }]);
    expect(page.body.changes[0].card).not.toHaveProperty('claimed_by');
  });

  it('the brief lists lapsed orders, expiring them first', async () => {
    const o = await give('*');
    await claim(hermes, o.id, 60);
    await clock('2026-10-07T09:05:00Z');
    const b = (await call('GET', '/api/me/brief', { auth: owner.auth })).body;
    expect(b.lapsed_orders.map((c: { id: string }) => c.id)).toEqual([o.id]);
  });
});

describe('outcomes (A.3)', () => {
  it('the current lease’s outcome moves exec_state and is marked applied; a late one is stored, marked stale, and reaches the brief', async () => {
    const o = await give('*');
    await claim(hermes, o.id);
    const ok = await outcome(hermes, 'hermes', o.id, 1);
    expect(ok.status).toBe(201);
    expect((await row(o.id)).execState).toBe('done');
    expect((await row(o.id)).changeSeq).toBe(ok.body.change_seq + 1); // outcome lower, order higher (OPEN 20)
    expect((await row(outcomeId('hermes', o.id, 1))).outcome).toBe('applied');

    const late = await outcome(cal, 'cal', o.id, 1, { 'orders.result': 'failed' });
    expect(late.status).toBe(201);
    expect((await row(o.id)).execState).toBe('done');
    const b = (await call('GET', '/api/me/brief', { auth: owner.auth })).body;
    expect(b.late_outcomes).toEqual([expect.objectContaining({ id: outcomeId('cal', o.id, 1), order_outcome: 'stale', 'orders.claim_seq': 1, 'orders.result': 'failed' })]);
  });

  it('refuses an outcome without orders.result, or with another result, and stores nothing', async () => {
    const o = await give('*');
    await claim(hermes, o.id);
    for (const result of [undefined, 'ok', true]) {
      const r = await outcome(hermes, 'hermes', o.id, 1, { 'orders.result': result });
      expect(r, String(result)).toMatchObject({ status: 400, body: { error: 'invalid_card' } });
    }
    const id = outcomeId('hermes', o.id, 1);
    const noOrder = await call('PUT', cardPath(id), { auth: hermes, body: card(id, { kind: 'signal', 'orders.claim_seq': 1, 'orders.result': 'done' }) });
    expect(noOrder).toMatchObject({ status: 400, body: { error: 'invalid_card' } });
    expect(await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, id)))).toEqual([]);
    expect((await row(o.id)).execState).toBe('claimed');
  });

  it('a re-run’s outcome is a new card: the lapsed claim’s result is late, keyed by its claim; the current claim’s ends the order', async () => {
    const o = await give('*');
    await claim(hermes, o.id, 60);
    await clock('2026-10-07T09:05:00Z');
    expect((await claim(hermes, o.id, 60)).body.claim_seq).toBe(2);
    expect((await outcome(hermes, 'hermes', o.id, 1, { 'orders.result': 'failed' })).status).toBe(201);
    expect((await row(o.id)).execState).toBe('claimed');
    expect((await outcome(hermes, 'hermes', o.id, 2)).status).toBe(201);
    expect((await row(o.id)).execState).toBe('done');
    expect((await row(outcomeId('hermes', o.id, 1))).outcome).toBe('stale');
    expect((await row(outcomeId('hermes', o.id, 2))).outcome).toBe('applied');
    const b = (await call('GET', '/api/me/brief', { auth: owner.auth })).body;
    expect(b.late_outcomes.map((c: Record<string, unknown>) => [c.id, c['orders.claim_seq']])).toEqual([[outcomeId('hermes', o.id, 1), 1]]);
    const list = (await call('GET', '/api/me/orders', { auth: owner.auth })).body.orders;
    expect(list).toEqual([expect.objectContaining({ id: o.id, exec_state: 'done', progress: expect.objectContaining({ count: 2, latest: expect.objectContaining({ id: outcomeId('hermes', o.id, 2) }) }) })]);
  });

  it('an outcome after the owner cancelled is stored and does nothing', async () => {
    const o = await give('*');
    await claim(hermes, o.id);
    expect((await call('POST', `/api/me/cards/${encodeURIComponent(o.id)}/decision`, { auth: owner.auth, body: { decision: 'dismissed' } })).body.exec_state).toBe('cancelled');
    await outcome(hermes, 'hermes', o.id, 1);
    expect((await row(o.id)).execState).toBe('cancelled');
    expect((await row(outcomeId('hermes', o.id, 1))).outcome).toBe('stale');
  });
});

describe('/api/me/orders', () => {
  it('mints, lists with folded progress, and shows the order thread across producers', async () => {
    await clock('2026-10-07T09:00:00Z');
    const o = await give('*', 'Renew the parking permit');
    expect(o).toMatchObject({ kind: 'order', producer: 'head', to_producer: '*', exec_state: 'open', rendered_html: '<p>Any weekday morning.</p>' });
    expect(o).not.toHaveProperty('wildcard_eligible');
    await claim(hermes, o.id);
    const progress = `hermes:order:${ulid(o.id)}:progress-1-1`;
    await call('PUT', cardPath(progress), { auth: hermes, body: card(progress, { kind: 'signal', urgency: 'log', thread: o.id, title: 'Form found' }) });
    await outcome(hermes, 'hermes', o.id, 1);

    const list = (await call('GET', '/api/me/orders', { auth: owner.auth })).body.orders;
    expect(list).toEqual([expect.objectContaining({ id: o.id, exec_state: 'done', progress: { count: 2, latest: expect.objectContaining({ title: 'Done', order_outcome: 'applied' }) } })]);
    const detail = (await call('GET', `/api/me/cards/${encodeURIComponent(outcomeId('hermes', o.id, 1))}`, { auth: owner.auth })).body;
    expect(detail.thread.map((t: { id: string }) => t.id)).toEqual([o.id, progress, outcomeId('hermes', o.id, 1)]);
  });

  it('refuses a malformed order', async () => {
    for (const body of [{ title: 'x' }, { to_producer: 'a b', title: 'x' }, { to_producer: '*', title: '' }, { to_producer: '*', title: 'two\nlines' }]) {
      expect((await call('POST', '/api/me/orders', { auth: owner.auth, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('POST', '/api/me/orders', { auth: hermes, body: { to_producer: '*', title: 'x' } })).status).toBe(401);
  });
});
