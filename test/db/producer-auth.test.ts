import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { producerTokens } from '../../db/schema';
import { authenticateProducer, hashToken, mintProducerToken } from '../../lib/auth/producer';
import { ensureHead } from '../../lib/heads';
import { TEST_DATABASE_URL } from '../env';

const db = openDb(TEST_DATABASE_URL, 1);
afterAll(() => db.$client.end());

const req = (authorization?: string) => new Request('http://head/api/changes', { headers: authorization ? { authorization } : {} });

// A head of its own so this file never collides with the HTTP suites' `morten`.
const HEAD = 'producer-auth-test';

beforeEach(async () => {
  await migrateDatabase(TEST_DATABASE_URL);
  await ensureHead(db, HEAD);
  await db.delete(producerTokens).where(eq(producerTokens.headId, HEAD));
});

describe('producer tokens (§12)', () => {
  it('stores only the sha256 of the token, bound to one root, ceiling brief by default', async () => {
    const token = await mintProducerToken(db, { headId: HEAD, root: 'hermes' });
    const rows = await db.select().from(producerTokens).where(eq(producerTokens.headId, HEAD));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash.equals(hashToken(token))).toBe(true);
    expect(rows[0]).toMatchObject({ root: 'hermes', urgencyCeiling: 'brief', executor: false });
  });

  it('authenticates a bearer token to its head, root and ceiling', async () => {
    const token = await mintProducerToken(db, { headId: HEAD, root: 'goalpath', ceiling: 'immediate', executor: true });
    await expect(authenticateProducer(db, req(`Bearer ${token}`))).resolves.toEqual({
      headId: HEAD, root: 'goalpath', instance: null, executor: true, ceiling: 'immediate',
    });
  });

  it('refuses no token, an unknown token, a revoked token and a Session credential with 401 unauthorized', async () => {
    const token = await mintProducerToken(db, { headId: HEAD, root: 'hermes' });
    await db.update(producerTokens).set({ revokedAt: new Date() }).where(and(eq(producerTokens.headId, HEAD)));
    for (const auth of [undefined, 'Bearer pbcp_unknown', `Bearer ${token}`, `Session ${token}`]) {
      await expect(authenticateProducer(db, req(auth))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    }
  });

  it('issues no token for the head: root (A.1) and none for a root outside the grammar (§5)', async () => {
    await expect(mintProducerToken(db, { headId: HEAD, root: 'head' })).rejects.toThrow();
    await expect(mintProducerToken(db, { headId: HEAD, root: 'not:a:root' })).rejects.toThrow();
  });
});
