import { beforeEach, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, OWNER, resetHead, testDb } from './helpers';

let hermes: string;
let goalpath: string;
beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { syncPageSize: null } });
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
  goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
});

const put = (id: string, auth: string) => call('PUT', cardPath(id), { auth, body: card(id) });
const sync = (after: number | string, auth = hermes) => call('GET', `/api/changes?after=${after}`, { auth });

describe('GET /api/changes (§7.2)', () => {
  it('returns the caller’s cards ascending, and next is the global maximum examined', async () => {
    await put('hermes:gmail:1', hermes); // 1
    await put('goalpath:item:1', goalpath); // 2
    await put('hermes:gmail:2', hermes); // 3
    await put('goalpath:item:2', goalpath); // 4
    const r = await sync(0);
    expect(r.status).toBe(200);
    expect(r.body.changes.map((c: { seq: number; card: { id: string } }) => [c.seq, c.card.id])).toEqual([[1, 'hermes:gmail:1'], [3, 'hermes:gmail:2']]);
    expect(r.body.next).toBe(4);
    expect((await sync(4)).body).toEqual({ changes: [], next: 4 });
    expect((await sync(99)).body).toEqual({ changes: [], next: 99 });
  });

  it('when the page is capped, next is the seq of the last entry returned', async () => {
    await call('POST', '/api/test', { body: { syncPageSize: 2 } });
    for (const n of [1, 2]) await put(`hermes:gmail:${n}`, hermes); // 1, 2
    await put('goalpath:item:1', goalpath); // 3
    await put('hermes:gmail:3', hermes); // 4
    const first = await sync(0);
    expect(first.body.changes.map((c: { seq: number }) => c.seq)).toEqual([1, 2]);
    expect(first.body.next).toBe(2);
    const second = await sync(2);
    expect(second.body).toMatchObject({ changes: [{ seq: 4 }], next: 4 });
  });

  it('treats a missing after as 0 and refuses a malformed one with 400', async () => {
    await put('hermes:gmail:1', hermes);
    expect((await call('GET', '/api/changes', { auth: hermes })).body.changes).toHaveLength(1);
    for (const bad of ['-1', 'abc', '1.5', '99999999999999999999']) {
      expect((await sync(bad)).status).toBe(400);
    }
  });

  it('requires a producer token', async () => {
    expect((await call('GET', '/api/changes?after=0')).status).toBe(401);
  });
});
