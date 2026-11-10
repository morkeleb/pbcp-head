// Card content at rest (lib/crypto.ts, lib/vault.ts, lib/at-rest.ts): what reaches the database is ciphertext, the head
// reads it back through its routes as before, a tampered row fails closed while the rest is served, the master key can
// be rotated, the backfill seals a database written before encryption without dropping anything, and deleting a head
// destroys its key first.

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cards, decisionLog, diagrams, heads, inviteRequests } from '../../db/schema';
import { backfill, decryptCard, deleteHead, destroyKey, remaining, rewrap } from '../../lib/at-rest';
import { mintProducerToken } from '../../lib/auth/producer';
import { masterKey } from '../../lib/crypto';
import { requireMasterKeyIfNeeded } from '../../lib/keys';
import { openRows } from '../../lib/store';
import { TEST_HEAD_MASTER_KEY } from '../env';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';

const SECRET = 'Kiwi-lawyer-7731';
let owner: { auth: string; deviceId: string };
let mail: string;

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z' } });
  owner = await ownerSession(OWNER, 'laptop');
  mail = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'mail' })}`;
});
afterEach(() => call('POST', '/api/test', { body: { clock: null } }));

/** Rows of `table` (every column, as text) that contain `needle`. */
async function rowsWith(table: string, needle: string): Promise<number> {
  const [r] = (await testDb().execute(sql.raw(`select count(*)::int as n from ${table} t where t::text like '%${needle}%'`))) as unknown as Array<{ n: number }>;
  return r!.n;
}
const anywhere = async (needle: string) => (await rowsWith('cards', needle)) + (await rowsWith('decision_log', needle)) + (await rowsWith('diagrams', needle)) + (await rowsWith('invite_requests', needle));

describe('content at rest', () => {
  it('round-trips through the PUT and the brief, and the title is nowhere in the database', async () => {
    expect((await call('PUT', cardPath('mail:x:1'), { auth: mail, body: card('mail:x:1', { title: `Reply to ${SECRET}`, summary: `About ${SECRET}.`, labels: ['divorce-lawyer'], source: { url: `https://mail.example/${SECRET}`, label: SECRET } }) })).status).toBe(201);
    const b = (await call('GET', '/api/me/brief', { auth: owner.auth })).body;
    const c = b.decisions.find((d: { id: string }) => d.id === 'mail:x:1');
    expect(c).toMatchObject({ title: `Reply to ${SECRET}`, summary: `About ${SECRET}.`, labels: ['divorce-lawyer'], source: { url: `https://mail.example/${SECRET}` } });
    expect(c.rendered_lead).toContain(SECRET);
    // Decided with a comment and an edited proposal: the log too.
    expect((await call('POST', `/api/me/cards/${encodeURIComponent('mail:x:1')}/decision`, { auth: owner.auth, body: { decision: 'approve', comment: `Tell ${SECRET}` } })).status).toBe(200);
    const d = (await call('GET', `/api/me/cards/${encodeURIComponent('mail:x:1')}`, { auth: owner.auth })).body;
    expect(d.card).toMatchObject({ title: `Reply to ${SECRET}`, comment: `Tell ${SECRET}`, state: 'decided', decision: 'approve' });
    expect(d.decisions[0]).toMatchObject({ decision: 'approve', comment: `Tell ${SECRET}` });
    // The producer reads it back through sync, in clear (§7.2): only the database holds ciphertext.
    const sync = (await call('GET', '/api/changes?after=0', { auth: mail })).body;
    expect(sync.changes.at(-1).card).toMatchObject({ title: `Reply to ${SECRET}`, decision: 'approve', labels: ['divorce-lawyer'] });
    // Raw SQL over every row of every table that holds content: neither the title, the label nor the comment.
    expect(await anywhere(SECRET)).toBe(0);
    expect(await anywhere('divorce-lawyer')).toBe(0);
    // The metadata the head routes and syncs by is clear.
    const [row] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'mail:x:1')));
    expect(row!.producerDoc).toMatchObject({ id: 'mail:x:1', kind: 'decision', producer: 'mail' });
    expect(row).toMatchObject({ state: 'decided', decision: 'approve', renderedHtml: null, comment: null });
  });

  it('fails closed on a tampered card: left out with a logged error, and the brief renders the rest', async () => {
    await call('PUT', cardPath('mail:x:1'), { auth: mail, body: card('mail:x:1', { title: 'Kept' }) });
    await call('PUT', cardPath('mail:x:2'), { auth: mail, body: card('mail:x:2', { title: 'Tampered' }) });
    const [row] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'mail:x:2')));
    const content = row!.content as { doc: string };
    const b = Buffer.from(content.doc.slice(3), 'base64');
    b[30] = b[30]! ^ 1;
    await testDb().update(cards).set({ content: { ...content, doc: `e1:${b.toString('base64')}` } }).where(and(eq(cards.headId, OWNER), eq(cards.id, 'mail:x:2')));
    const r = await call('GET', '/api/me/brief', { auth: owner.auth });
    expect(r.status).toBe(200);
    expect(r.body.decisions.map((d: { id: string }) => d.id)).toEqual(['mail:x:1']);
    expect((await call('GET', `/api/me/cards/${encodeURIComponent('mail:x:2')}`, { auth: owner.auth })).status).toBe(404);
  });

  it('binds content to its row: a content column copied in SQL from one card to another makes the second fail closed, the first still reads', async () => {
    await call('PUT', cardPath('mail:x:1'), { auth: mail, body: card('mail:x:1', { title: 'The original' }) });
    await call('PUT', cardPath('mail:x:2'), { auth: mail, body: card('mail:x:2', { title: 'The victim' }) });
    // Both rendered, so nothing writes the rows while the copy is made.
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const rows = await testDb().select().from(cards).where(eq(cards.headId, OWNER));
      if (rows.filter((r) => (r.content as Record<string, unknown> | null)?.html).length >= 2) break;
    }
    await testDb().execute(sql`update cards set content = (select content from cards where head_id = ${OWNER} and id = 'mail:x:1') where head_id = ${OWNER} and id = 'mail:x:2'`);
    const b = await call('GET', '/api/me/brief', { auth: owner.auth });
    expect(b.status).toBe(200);
    expect(b.body.decisions.map((d: { id: string; title: string }) => [d.id, d.title])).toEqual([['mail:x:1', 'The original']]);
    expect((await call('GET', `/api/me/cards/${encodeURIComponent('mail:x:2')}`, { auth: owner.auth })).status).toBe(404);
    expect((await call('GET', `/api/me/cards/${encodeURIComponent('mail:x:1')}`, { auth: owner.auth })).body.card.title).toBe('The original');
  });

  it('seals a head’s diagrams, serves them only through its own key, and keeps the email of an invite request sealed', async () => {
    await call('PUT', cardPath('mail:x:3'), { auth: mail, body: card('mail:x:3', { title: 'Chart', body: '```mermaid\npie title Kiwi\n  "a" : 1\n  "b" : 2\n```' }) });
    let html = '';
    for (const end = Date.now() + 20_000; Date.now() < end && !html.includes('/api/me/svg/'); await new Promise((r) => setTimeout(r, 200))) {
      html = (await call('GET', `/api/me/cards/${encodeURIComponent('mail:x:3')}`, { auth: owner.auth })).body.card.rendered_html;
    }
    const src = /\/api\/me\/svg\/[0-9a-f]{64}\?h=morten/.exec(html)?.[0];
    expect(src).toBeTruthy();
    const svg = await call('GET', src!.replace('?h=morten', `?h=${OWNER}`));
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toMatch(/svg/);
    expect((await call('GET', src!.replace('?h=morten', '?h=someone-else'))).status).toBe(404);
    expect((await call('GET', src!.replace('?h=morten', ''))).status).toBe(404);
    expect(await rowsWith('diagrams', 'Kiwi')).toBe(0);
    const [d] = await testDb().select().from(diagrams).where(eq(diagrams.hash, /svg\/([0-9a-f]{64})/.exec(src!)![1]!));
    expect(d).toMatchObject({ svg: null, svgDark: null, error: null });

    expect((await call('POST', '/api/invite', { body: { email: 'Kiwi.Person@example.com' } })).status).toBe(202);
    expect((await call('POST', '/api/invite', { body: { email: 'kiwi.person@EXAMPLE.com' } })).status).toBe(202); // the same, in other case
    expect(await rowsWith('invite_requests', 'example.com')).toBe(0);
    const list = (await call('GET', '/api/me/settings/invites', { auth: owner.auth })).body.requests;
    expect(list.map((x: { email: string }) => x.email)).toEqual(['Kiwi.Person@example.com']);
  });

  it('rewraps every head’s data key under a new master key, leaving the cards as they were', async () => {
    await call('PUT', cardPath('mail:x:1'), { auth: mail, body: card('mail:x:1', { title: SECRET }) });
    // Rendered after the PUT commits: wait for it, so nothing writes the row while the key is rotated.
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const [r] = await testDb().select().from(cards).where(eq(cards.id, 'mail:x:1'));
      if ((r!.content as Record<string, unknown>).html) break;
    }
    const [before] = await testDb().select().from(cards).where(eq(cards.id, 'mail:x:1'));
    const fresh = Buffer.alloc(32, 42);
    expect(await rewrap(testDb(), fresh)).toBe(1);
    const [after] = await testDb().select().from(cards).where(eq(cards.id, 'mail:x:1'));
    expect(after!.content).toEqual(before!.content); // not one card re-encrypted
    // The head (still on the old key) can no longer unwrap; the new key can.
    process.env.HEAD_MASTER_KEY = fresh.toString('base64');
    try {
      expect((await decryptCard(testDb(), 'mail:x:1'))!.card.title).toBe(SECRET);
      // Back again, for the head under test.
      expect(await rewrap(testDb(), masterKey({ HEAD_MASTER_KEY: TEST_HEAD_MASTER_KEY })!)).toBe(1);
    } finally {
      process.env.HEAD_MASTER_KEY = TEST_HEAD_MASTER_KEY;
    }
    expect((await call('GET', `/api/me/cards/${encodeURIComponent('mail:x:1')}`, { auth: owner.auth })).body.card.title).toBe(SECRET);
  });

  it('refuses to start without HEAD_MASTER_KEY once any head has a data key', async () => {
    await expect(requireMasterKeyIfNeeded(testDb(), {})).resolves.toBeUndefined(); // no content yet: nothing to read
    await call('PUT', cardPath('mail:x:1'), { auth: mail, body: card('mail:x:1') });
    await expect(requireMasterKeyIfNeeded(testDb(), {})).rejects.toThrow(/HEAD_MASTER_KEY is not set/);
    await expect(requireMasterKeyIfNeeded(testDb(), { HEAD_MASTER_KEY: 'nope' })).rejects.toThrow(/32 random bytes/);
    await expect(requireMasterKeyIfNeeded(testDb(), { HEAD_MASTER_KEY: TEST_HEAD_MASTER_KEY })).resolves.toBeUndefined();
  });

  it('deletes a head by destroying its key first: its rows are unreadable from that moment, then gone', async () => {
    await call('PUT', cardPath('mail:x:1'), { auth: mail, body: card('mail:x:1', { title: SECRET }) });
    // The render after the PUT writes the row (and would make a key again): let it finish first.
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const [r] = await testDb().select().from(cards).where(eq(cards.id, 'mail:x:1'));
      if ((r!.content as Record<string, unknown>).html) break;
    }
    await destroyKey(testDb(), OWNER);
    const rows = await testDb().select().from(cards).where(eq(cards.headId, OWNER));
    expect(rows.length).toBeGreaterThan(0);
    await expect(openRows(testDb(), rows)).rejects.toThrow(/no data key/);
    await deleteHead(testDb(), OWNER);
    expect(await testDb().select().from(cards).where(eq(cards.headId, OWNER))).toEqual([]);
    expect(await testDb().select().from(heads).where(eq(heads.id, OWNER))).toEqual([]);
  });
});

describe('the backfill (pnpm encrypt-backfill)', () => {
  it('seals a database written before encryption, idempotently, drops nothing, and --verify then counts zero', async () => {
    // A head and rows as they were before this change: plaintext producer_doc, rendered columns, comment, decision log,
    // an unscoped diagram the card's HTML points at, and an invite request.
    const doc = { protocol: 'pbcp/1', id: 'mail:old:1', kind: 'decision', to_person: OWNER, producer: 'mail', title: `Old ${SECRET}`, body: `Body ${SECRET}`, labels: ['old-label'], emitted_at: '2026-10-01T09:00:00Z' };
    const hash = 'a'.repeat(64);
    await testDb().execute(sql`update change_counter set seq = 1 where head_id = ${OWNER}`);
    await testDb().insert(cards).values({
      headId: OWNER, id: 'mail:old:1', producer: 'mail', namespace: 'old', producerDoc: doc, delivery: 'brief', state: 'decided', changeSeq: 1, decision: 'approve',
      receivedAt: new Date('2026-10-01T09:00:00Z'), changedAt: new Date('2026-10-01T09:00:00Z'), day: '2026-10-01', decidedAt: new Date('2026-10-01T10:00:00Z'),
      comment: `Comment ${SECRET}`, decidedDoc: doc, renderedHtml: `<p>Body ${SECRET}</p><img src="/api/me/svg/${hash}">`, renderedFrom: 'x',
      renderedMeta: { firstVisual: null, fences: [], lead: { text: `Body ${SECRET}`, source: 'body', html: `Body ${SECRET}` } },
    });
    await testDb().insert(decisionLog).values({ headId: OWNER, cardId: 'mail:old:1', decision: 'approve', comment: `Comment ${SECRET}`, decidedAt: new Date('2026-10-01T10:00:00Z'), decidedDoc: doc, actor: 'x' });
    await testDb().insert(diagrams).values({ hash, type: 'pie', svg: `<svg><text>${SECRET}</text></svg>` });
    await testDb().insert(inviteRequests).values({ email: 'old.person@example.com' });

    expect(await remaining(testDb())).toEqual({ cards: 1, decision_log: 1, diagrams: 1, invite_requests: 1 });
    expect(await backfill(testDb())).toEqual({ cards: 0, decision_log: 0, diagrams: 0, invite_requests: 0 });
    expect(await backfill(testDb())).toEqual({ cards: 0, decision_log: 0, diagrams: 0, invite_requests: 0 }); // again: nothing to do

    // Read through the head as before, from the sealed content.
    const d = (await call('GET', `/api/me/cards/${encodeURIComponent('mail:old:1')}`, { auth: owner.auth })).body;
    expect(d.card).toMatchObject({ title: `Old ${SECRET}`, labels: ['old-label'], comment: `Comment ${SECRET}` });
    expect(d.decisions[0]).toMatchObject({ comment: `Comment ${SECRET}` });
    // Nothing dropped: the plaintext columns are still there, for the drop-columns migration to remove.
    const [row] = await testDb().select().from(cards).where(eq(cards.id, 'mail:old:1'));
    expect(row!.renderedHtml).toContain(SECRET);
    expect((row!.content as Record<string, string>).doc!.startsWith('e1:')).toBe(true);
    // The diagram, copied sealed under the head's scoped hash; the old row marked, not deleted.
    const old = await testDb().select().from(diagrams).where(eq(diagrams.hash, hash));
    expect(old[0]).toMatchObject({ content: { migrated: true } });
    expect((await testDb().select().from(diagrams)).length).toBe(2);
    const list = (await call('GET', '/api/me/settings/invites', { auth: owner.auth })).body.requests;
    expect(list[0].email).toBe('old.person@example.com');
  });
});
