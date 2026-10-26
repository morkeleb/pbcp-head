import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cards, decisionLog } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';

let hermes: string;
let owner: { auth: string; deviceId: string };
beforeEach(async () => {
  await resetHead();
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
  owner = await ownerSession();
});

const put = (id: string, extra: Record<string, unknown> = {}) => call('PUT', cardPath(id), { auth: hermes, body: card(id, extra) });
const decide = (path: string, body: unknown, auth = owner.auth) => call('POST', path, { auth, body });

describe('decide (§7.3)', () => {
  it('decides at the RFC path and under /api/me, freezing the decided version and logging the device', async () => {
    await put('hermes:gmail:1');
    const r = await decide(`${cardPath('hermes:gmail:1')}/decision`, { decision: 'approve', comment: 'ok' });
    expect(r).toMatchObject({ status: 200, body: { state: 'decided', decision: 'approve', comment: 'ok', change_seq: 2 } });

    await put('hermes:gmail:2');
    const me = await decide(`/api/me/cards/${encodeURIComponent('hermes:gmail:2')}/decision`, { decision: 'edited', edited_proposal: 'Say no' });
    expect(me).toMatchObject({ status: 200, body: { decision: 'edited', edited_proposal: 'Say no' } });

    const log = await testDb().select().from(decisionLog).orderBy(decisionLog.seq);
    expect(log.map((l) => [l.cardId, l.decision, l.actor])).toEqual([
      ['hermes:gmail:1', 'approve', owner.deviceId],
      ['hermes:gmail:2', 'edited', owner.deviceId],
    ]);
    expect((log[0]!.decidedDoc as { id: string; state?: string }).id).toBe('hermes:gmail:1');
    expect(log[0]!.decidedDoc).not.toHaveProperty('state');
    const [row] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'hermes:gmail:1')));
    expect(row!.decidedDoc).toEqual(log[0]!.decidedDoc);
  });

  it('returns 409 with the stored card for a decided card and logs nothing more', async () => {
    await put('hermes:gmail:1');
    await decide(`${cardPath('hermes:gmail:1')}/decision`, { decision: 'approve' });
    const again = await decide(`${cardPath('hermes:gmail:1')}/decision`, { decision: 'reject' });
    expect(again).toMatchObject({ status: 409, body: { decision: 'approve' } });
    expect(await testDb().select().from(decisionLog)).toHaveLength(1);
  });

  it('refuses with the §7.4 codes', async () => {
    await put('hermes:gmail:1');
    await put('hermes:gmail:2', { kind: 'signal' });
    const path = `${cardPath('hermes:gmail:1')}/decision`;
    expect((await decide(`${cardPath('hermes:gmail:9')}/decision`, { decision: 'approve' })).body.error).toBe('not_found');
    expect((await call('POST', path, { auth: owner.auth, body: '{nope', type: 'application/json' })).body.error).toBe('malformed_json');
    expect((await decide(path, { decision: 'maybe' })).body.error).toBe('invalid_decision');
    expect((await decide(path, { decision: 'delegated' })).body.error).toBe('invalid_decision');
    expect((await decide(`${cardPath('hermes:gmail:2')}/decision`, { decision: 'approve' })).body.error).toBe('not_decidable');
  });

  it('takes a session only: a producer token is refused, even for its own card', async () => {
    await put('hermes:gmail:1');
    for (const path of [`${cardPath('hermes:gmail:1')}/decision`, `/api/me/cards/${encodeURIComponent('hermes:gmail:1')}/decision`]) {
      expect(await decide(path, { decision: 'approve' }, hermes)).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
      expect((await decide(path, { decision: 'approve' }, '')).status).toBe(401);
    }
  });

  it("only reaches the session's own head", async () => {
    await put('hermes:gmail:1');
    const { ensureHead } = await import('../../lib/heads');
    await ensureHead(testDb(), 'anna');
    const anna = await ownerSession('anna');
    expect((await decide(`${cardPath('hermes:gmail:1')}/decision`, { decision: 'approve' }, anna.auth)).status).toBe(404);
  });
});

describe('seen and acknowledge (§4.2)', () => {
  it('seen sets seen_at once and bumps change_seq; repeating it changes nothing', async () => {
    await put('hermes:gmail:1');
    const path = `/api/me/cards/${encodeURIComponent('hermes:gmail:1')}/seen`;
    const first = await call('POST', path, { auth: owner.auth });
    expect(first).toMatchObject({ status: 200, body: { seen_at: expect.any(String), change_seq: 2 } });
    expect((await call('POST', path, { auth: owner.auth })).body.change_seq).toBe(2);
  });

  it('ack sets acknowledged_at on an artifact and refuses a decision card with not_acknowledgeable', async () => {
    await put('hermes:gmail:1', { kind: 'artifact' });
    await put('hermes:gmail:2');
    const ack = (id: string) => call('POST', `/api/me/cards/${encodeURIComponent(id)}/ack`, { auth: owner.auth });
    expect(await ack('hermes:gmail:1')).toMatchObject({ status: 200, body: { state: 'open', acknowledged_at: expect.any(String) } });
    expect(await ack('hermes:gmail:2')).toMatchObject({ status: 400, body: { error: 'not_acknowledgeable' } });
  });
});
