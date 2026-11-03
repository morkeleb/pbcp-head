// The storage layer under the protocol's own rules: §5's submission table and equality rules, as `submitCard` stores
// them (a re-PUT that §5 calls identical changes nothing at all), and §8's successor chain (`newestSuccessor`).

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { cards, decisionLog } from '../../db/schema';
import { ensureHead } from '../../lib/heads';
import { decideCard, markCardSeen, submitCard } from '../../lib/protocol';
import { load, newestSuccessor } from '../../lib/store';
import { TEST_DATABASE_URL } from '../env';

const db = openDb(TEST_DATABASE_URL, 1);
afterAll(() => db.$client.end());

// A head of its own so this file never collides with the HTTP suites' `morten`.
const HEAD = 'store-test';
const ctx = { headId: HEAD, root: 'cal', ceiling: 'immediate' as const };
const owner = { headId: HEAD, actor: 'store-test-device' };

beforeEach(async () => {
  await migrateDatabase(TEST_DATABASE_URL);
  await ensureHead(db, HEAD);
  await db.delete(decisionLog).where(eq(decisionLog.headId, HEAD));
  await db.delete(cards).where(eq(cards.headId, HEAD));
});

const tick = () => new Promise((r) => setTimeout(r, 5));

/** The card from the report of 2026-10-30, re-sent with only `emitted_at` changed. */
const occurrence = (extra: Record<string, unknown> = {}) => ({
  protocol: 'pbcp/1',
  id: 'cal:event:2mo115vij4sh4qtj5un6gfc7mk',
  kind: 'artifact',
  to_person: HEAD,
  producer: 'cal',
  title: 'TSA PreCheck enrollment appointment (CLEAR)',
  summary: '15:45–16:15 · SLC Airport, Main Terminal · personal',
  body: '- When: 15:45–16:15\n- Where: SLC Airport, Main Terminal\n- Calendar: personal',
  urgency: 'log',
  thread: 'day-2026-10-30',
  labels: ['personal'],
  about: '2026-10-30',
  at: '2026-10-30T21:45:00Z',
  until: '2026-10-30T22:15:00Z',
  source: { url: 'https://calendar.example/event?eid=Mm1v', label: 'Calendar event' },
  emitted_at: '2026-10-30T15:15:11.813Z',
  ...extra,
});

const decision = (id: string, extra: Record<string, unknown> = {}) => ({
  protocol: 'pbcp/1', id, kind: 'decision', to_person: HEAD, producer: 'cal', title: 'Keep the table?', body: 'The restaurant holds it.', emitted_at: '2026-10-30T09:00:00Z', ...extra,
});

const put = (card: Record<string, unknown>) => submitCard(db, ctx, JSON.stringify(card), encodeURIComponent(String(card.id)));
const row = async (id: string) => (await db.select().from(cards).where(and(eq(cards.headId, HEAD), eq(cards.id, id))))[0]!;
/** Everything §5 says an identical re-PUT leaves alone. */
const unchanged = (r: Awaited<ReturnType<typeof row>>) => ({ changeSeq: r.changeSeq, receivedAt: r.receivedAt, changedAt: r.changedAt, seenAt: r.seenAt, delivery: r.delivery, emitted: (r.producerDoc as { emitted_at: string }).emitted_at, day: r.day });

describe('§5 submission table, as stored', () => {
  it('none → 201 open', async () => {
    const r = await put(occurrence());
    expect(r.status).toBe(201);
    expect(r.card).toMatchObject({ state: 'open', delivery: 'log' });
  });

  it('open, identical (only emitted_at differs) → 200 and nothing changes: change_seq, received_at, changed_at, seen_at, emitted_at, delivery', async () => {
    await put(occurrence());
    await markCardSeen(db, owner, occurrence().id);
    const before = unchanged(await row(occurrence().id));
    await tick();
    const r = await put(occurrence({ emitted_at: '2026-10-30T15:15:36.272Z' }));
    expect(r.status).toBe(200);
    expect(r.card).toMatchObject({ change_seq: before.changeSeq, emitted_at: '2026-10-30T15:15:11.813Z' });
    expect(unchanged(await row(occurrence().id))).toEqual(before);
  });

  it('open, different → 200 replaced, received_at updated; seen_at cleared only when body or actions change', async () => {
    await put(occurrence());
    await markCardSeen(db, owner, occurrence().id);
    const first = await row(occurrence().id);
    await tick();
    // A moved time, the body as it was: replaced, still seen.
    let r = await put(occurrence({ at: '2026-10-30T22:00:00Z', until: '2026-10-30T22:30:00Z' }));
    expect(r.status).toBe(200);
    let now = await row(occurrence().id);
    expect(now.changeSeq).toBeGreaterThan(first.changeSeq);
    expect(now.receivedAt.getTime()).toBeGreaterThan(first.receivedAt.getTime());
    expect(now.seenAt).toEqual(first.seenAt);
    expect(r.card.at).toBe('2026-10-30T22:00:00Z');
    // A new body: seen_at cleared, so the person sees the revision as new.
    await tick();
    r = await put(occurrence({ at: '2026-10-30T22:00:00Z', until: '2026-10-30T22:30:00Z', body: '- When: 16:00–16:30' }));
    now = await row(occurrence().id);
    expect(now.seenAt).toBeNull();
    // Actions on a decision card: the same.
    await put(decision('cal:x:table'));
    await markCardSeen(db, owner, 'cal:x:table');
    await put(decision('cal:x:table', { actions: ['keep', 'release'] }));
    expect((await row('cal:x:table')).seenAt).toBeNull();
  });

  it('decided, identical → 200 with the stored card and its decision; decided, different → 409', async () => {
    await put(decision('cal:x:table'));
    await decideCard(db, owner, 'cal:x:table', { decision: 'approve' });
    const before = unchanged(await row('cal:x:table'));
    let r = await put(decision('cal:x:table', { emitted_at: '2026-10-31T09:00:00Z' }));
    expect([r.status, r.card.decision]).toEqual([200, 'approve']);
    expect(unchanged(await row('cal:x:table'))).toEqual(before);
    r = await put(decision('cal:x:table', { title: 'Keep the table for four?' }));
    expect([r.status, r.card.decision, r.card.title]).toEqual([409, 'approve', 'Keep the table?']);
  });

  it('superseded, identical → 200 with the stored card; superseded, different → 409', async () => {
    await put(decision('cal:x:a'));
    await put(decision('cal:x:b', { supersedes: 'cal:x:a' }));
    const before = unchanged(await row('cal:x:a'));
    let r = await put(decision('cal:x:a', { emitted_at: '2026-10-31T09:00:00Z' }));
    expect([r.status, r.card.state]).toEqual([200, 'superseded']);
    expect(unchanged(await row('cal:x:a'))).toEqual(before);
    r = await put(decision('cal:x:a', { body: 'Changed.' }));
    expect([r.status, r.card.state]).toEqual([409, 'superseded']);
  });
});

describe('§5 equality, as stored: each of these re-PUTs is identical, so nothing changes', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['labels as a set', { labels: ['personal', 'travel'] }, { labels: ['travel', 'personal'] }],
    ['an absent urgency is brief', { urgency: 'brief' }, { urgency: undefined }],
    ['an absent references is []', { references: [] }, { references: undefined }],
    ['an absent labels is []', { labels: [] }, { labels: undefined }],
    ['trailing whitespace in body', { body: 'Body.' }, { body: 'Body.\n\n  ' }],
    ['member order in objects', { source: { url: 'https://x.example/', label: 'X' } }, { source: { label: 'X', url: 'https://x.example/' } }],
    ['an unknown field by value', { 'x-run': { n: 1, tags: ['a'] } }, { 'x-run': { tags: ['a'], n: 1 } }],
  ];
  for (const [rule, first, second] of cases) {
    it(rule, async () => {
      await put(occurrence(first));
      const before = unchanged(await row(occurrence().id));
      await tick();
      const r = await put(occurrence({ ...second, emitted_at: '2026-10-31T00:00:00Z' }));
      expect(r.status, rule).toBe(200);
      expect(unchanged(await row(occurrence().id)), rule).toEqual(before);
    });
  }

  const decisions: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['an absent actions on a decision is [approve, reject]', { actions: ['approve', 'reject'] }, {}],
    ['a string action is an object with that id', { actions: ['keep', 'release'] }, { actions: [{ id: 'keep' }, { id: 'release' }] }],
    ['default: false is no default', { actions: [{ id: 'keep', default: false }, 'release'] }, { actions: ['keep', 'release'] }],
  ];
  for (const [rule, first, second] of decisions) {
    it(rule, async () => {
      await put(decision('cal:x:eq', first));
      const before = unchanged(await row('cal:x:eq'));
      await tick();
      const r = await put(decision('cal:x:eq', { ...second, emitted_at: '2026-10-31T00:00:00Z' }));
      expect(r.status, rule).toBe(200);
      expect(unchanged(await row('cal:x:eq')), rule).toEqual(before);
    });
  }

  it('list order counts outside labels: references in another order is a different card', async () => {
    await put(occurrence({ references: ['cal:x:1', 'cal:x:2'] }));
    const before = await row(occurrence().id);
    await tick();
    const r = await put(occurrence({ references: ['cal:x:2', 'cal:x:1'] }));
    expect(r.status).toBe(200);
    expect((await row(occurrence().id)).changeSeq).toBeGreaterThan(before.changeSeq);
  });
});

describe('§8 the successor chain (newestSuccessor)', () => {
  it('follows supersedes to the newest card, decided or not; null for the current card', async () => {
    const chain = ['cal:mail:a:triage', 'cal:mail:b:triage', 'cal:mail:c:triage-2', 'cal:mail:d:triage-3'];
    for (const [i, id] of chain.entries()) await put(decision(id, { thread: 'thr-1a19faefeef3ed82', actions: ['archive', 'keep', 'task'], ...(i > 0 ? { supersedes: chain[i - 1] } : {}) }));
    await decideCard(db, owner, chain[3]!, { decision: 'task' });
    for (const id of chain.slice(0, 3)) {
      const stored = (await load(db, HEAD, id))!.card;
      expect(stored.state, id).toBe('superseded');
      expect(await newestSuccessor(db, HEAD, stored), id).toMatchObject({ id: chain[3], state: 'decided', decision: 'task' });
    }
    expect(await newestSuccessor(db, HEAD, (await load(db, HEAD, chain[3]!))!.card)).toBeNull();
  });
});
