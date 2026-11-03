// The storage layer under the protocol's own rules: §8's successor chain (`newestSuccessor`).

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { cards, decisionLog } from '../../db/schema';
import { ensureHead } from '../../lib/heads';
import { decideCard, submitCard } from '../../lib/protocol';
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

const decision = (id: string, extra: Record<string, unknown> = {}) => ({
  protocol: 'pbcp/1', id, kind: 'decision', to_person: HEAD, producer: 'cal', title: 'Keep the table?', body: 'The restaurant holds it.', emitted_at: '2026-10-30T09:00:00Z', ...extra,
});

const put = (card: Record<string, unknown>) => submitCard(db, ctx, JSON.stringify(card), encodeURIComponent(String(card.id)));

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
