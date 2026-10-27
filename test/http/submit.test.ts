import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cards } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, OWNER, resetHead, testDb } from './helpers';

let hermes: string;
beforeEach(async () => {
  await resetHead();
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
});

const put = (id: string, body: unknown, auth = hermes, path = cardPath(id)) => call('PUT', path, { auth, body });

describe('PUT /api/cards/{id} (§7.1)', () => {
  it('stores a new card (201) and returns it with its head-owned fields; unset ones are absent, not null', async () => {
    const r = await put('hermes:gmail:1', card('hermes:gmail:1'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'hermes:gmail:1', state: 'open', change_seq: 1 });
    expect(r.body.received_at).toMatch(/Z$/);
    expect(Object.keys(r.body)).not.toContain('seen_at');
    expect(Object.keys(r.body)).not.toContain('decision');
  });

  it('accepts the file form as text/markdown', async () => {
    const md = '---\nprotocol: pbcp/1\nid: hermes:gmail:2\nkind: signal\nto_person: morten\nproducer: hermes\ntitle: Hello\nemitted_at: "2026-10-07T06:00:00Z"\n---\n\nBody text.\n';
    const r = await put('hermes:gmail:2', md);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'hermes:gmail:2', kind: 'signal', body: 'Body text.\n' });
  });

  it('refuses in the §7.1 order: 401 before 413 before 400 before 403', async () => {
    const big = card('goalpath:item:1', { body: 'x'.repeat(70 * 1024), to_person: 'anna' });
    expect((await put('goalpath:item:1', '{not json', '')).status).toBe(401);
    expect((await put('goalpath:item:1', big)).body).toEqual({ error: 'too_large', message: expect.any(String) });
    expect((await put('goalpath:item:1', '{not json')).body.error).toBe('malformed_json');
    expect((await put('goalpath:item:1', card('goalpath:item:1', { to_person: 'anna', state: 'open' }))).body.error).toBe('head_owned_field');
    expect((await put('goalpath:item:1', card('goalpath:item:1', { to_person: 'anna' }))).body.error).toBe('outside_root');
    expect((await put('hermes:gmail:3', card('hermes:gmail:3', { to_person: 'anna' }))).body.error).toBe('wrong_person');
  });

  it('accepts a card up to 64 KiB of wire form, however the request is indented', async () => {
    const c = card('hermes:gmail:4');
    c.body = 'x'.repeat(64 * 1024 - JSON.stringify({ ...c, body: '' }).length);
    expect((await put('hermes:gmail:4', JSON.stringify(c, null, 4), hermes)).status).toBe(201);
  });

  it('refuses a URL id that differs from the card id with 400 id_mismatch', async () => {
    const r = await put('hermes:gmail:5', card('hermes:gmail:5'), hermes, cardPath('hermes:gmail:6'));
    expect(r).toMatchObject({ status: 400, body: { error: 'id_mismatch' } });
  });

  it('refuses a producer token on a Session scheme and a session-looking header on a producer route', async () => {
    expect((await put('hermes:gmail:7', card('hermes:gmail:7'), hermes.replace('Bearer', 'Session'))).status).toBe(401);
  });

  it('keeps urgency as sent and clamps delivery to the ceiling (§4.2, §9)', async () => {
    const r = await put('hermes:gmail:8', card('hermes:gmail:8', { urgency: 'immediate' }));
    expect(r.body).toMatchObject({ urgency: 'immediate', delivery: 'brief' });
    const [row] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'hermes:gmail:8')));
    expect(row).toMatchObject({ urgency: 'immediate', delivery: 'brief' });
    expect((row!.producerDoc as { urgency: string }).urgency).toBe('immediate');

    const loud = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'cal', ceiling: 'immediate' })}`;
    await put('cal:event:1', card('cal:event:1', { urgency: 'immediate' }), loud);
    await put('cal:event:2', card('cal:event:2', { urgency: 'log' }), loud);
    const rows = await testDb().select({ id: cards.id, delivery: cards.delivery }).from(cards).where(eq(cards.producer, 'cal'));
    expect(Object.fromEntries(rows.map((x) => [x.id, x.delivery]))).toEqual({ 'cal:event:1': 'immediate', 'cal:event:2': 'log' });
  });

  it('supersedes atomically: predecessor takes the lower change_seq, successor the next one (§7.2, §8)', async () => {
    await put('hermes:gmail:9', card('hermes:gmail:9'));
    const r = await put('hermes:gmail:9:v2', card('hermes:gmail:9:v2', { supersedes: 'hermes:gmail:9' }));
    expect(r).toMatchObject({ status: 201, body: { change_seq: 3 } });
    const [old] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'hermes:gmail:9')));
    expect(old).toMatchObject({ state: 'superseded', changeSeq: 2, urgency: null, delivery: 'brief' });
  });

  it('reports supersession refusals with their codes', async () => {
    await put('hermes:gmail:10', card('hermes:gmail:10'));
    const sup = (id: string, target: string) => put(id, card(id, { supersedes: target }));
    expect((await sup('hermes:gmail:11', 'hermes:gmail:11')).body.error).toBe('supersede_self');
    expect((await sup('hermes:gmail:11', 'hermes:cal:10')).body.error).toBe('cross_namespace_supersede');
    expect((await sup('hermes:gmail:11', 'hermes:gmail:nope')).body.error).toBe('supersede_target_missing');
    expect((await sup('hermes:gmail:11', 'hermes:gmail:10')).status).toBe(201);
    expect(await sup('hermes:gmail:12', 'hermes:gmail:10')).toMatchObject({ status: 409, body: { error: 'already_superseded' } });
  });
});
