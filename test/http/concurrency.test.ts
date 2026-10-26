// What the in-process adapter cannot show: many writers at once. Writes to one head serialise on the
// change_counter row, so change_seq values are unique and commit in order, and a reader paging with `next`
// never skips a card that commits later with a lower seq (§7.2).

import { beforeEach, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';

let hermes: string;
beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { syncPageSize: 3 } });
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
});

describe('concurrent writers', () => {
  it('the same new id PUT many times at once: one 201, the rest 200, one stored card', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => call('PUT', cardPath('hermes:gmail:race'), { auth: hermes, body: card('hermes:gmail:race') })));
    expect(rs.map((r) => r.status).sort((x, y) => x - y)).toEqual([...Array(11).fill(200), 201]);
    expect(new Set(rs.map((r) => r.body.change_seq))).toEqual(new Set([1]));
  });

  it('a reader syncing while 60 cards and 20 decisions land sees every card once, in order', async () => {
    const owner = await ownerSession();
    const ids = Array.from({ length: 60 }, (_, i) => `hermes:gmail:c${i}`);
    const seen = new Map<string, number>();
    let cursor = 0;
    let writing = true;
    const reader = (async () => {
      while (writing || cursor < 80) {
        const r = await call('GET', `/api/changes?after=${cursor}`, { auth: hermes });
        expect(r.body.next).toBeGreaterThanOrEqual(cursor);
        for (const c of r.body.changes as Array<{ seq: number; card: { id: string } }>) {
          expect(c.seq).toBeGreaterThan(cursor);
          seen.set(c.card.id, c.seq);
        }
        if (r.body.next === cursor && !writing) break;
        cursor = r.body.next;
      }
    })();
    await Promise.all(ids.map((id) => call('PUT', cardPath(id), { auth: hermes, body: card(id) })));
    await Promise.all(ids.slice(0, 20).map((id) => call('POST', `${cardPath(id)}/decision`, { auth: owner.auth, body: { decision: 'approve' } })));
    writing = false;
    await reader;
    expect(cursor).toBe(80);
    expect([...seen.keys()].sort()).toEqual([...ids].sort());
  });
});
