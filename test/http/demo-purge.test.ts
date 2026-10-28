// pnpm demo:purge (scripts/demo-purge.ts) against the test database: the demo producers' cards and tokens go, a real
// producer on a demo root keeps everything but its `demo` cards, and the script will not run without --head.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cards, producerTokens } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { TEST_DATABASE_URL } from '../env';
import { card, cardPath } from './cards';
import { call, OWNER, resetHead, testDb } from './helpers';

const run = (args: string[]) =>
  promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/demo-purge.ts', ...args], { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL } });
const ids = async () => (await testDb().select({ id: cards.id }).from(cards).where(eq(cards.headId, OWNER))).map((c) => c.id).sort();

beforeEach(async () => {
  await resetHead();
  // A real n8n beside the demo's; mail only ever the demo's.
  const real = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'n8n' })}`;
  const demoN8n = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'n8n', instance: 'demo' })}`;
  const demoMail = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'mail', instance: 'demo' })}`;
  await call('PUT', cardPath('n8n:prices:1'), { auth: real, body: card('n8n:prices:1', { kind: 'artifact' }) });
  await call('PUT', cardPath('n8n:demo:chart'), { auth: demoN8n, body: card('n8n:demo:chart', { kind: 'artifact' }) });
  await call('PUT', cardPath('mail:inbox:old'), { auth: demoMail, body: card('mail:inbox:old', { kind: 'artifact' }) }); // an earlier demo run's, outside `demo`
  await call('PUT', cardPath('mail:demo:1'), { auth: demoMail, body: card('mail:demo:1', { kind: 'artifact' }) });
});

describe('pnpm demo:purge', () => {
  it('refuses to run without --head', async () => {
    await expect(run([])).rejects.toMatchObject({ code: 2 });
    expect(await ids()).toHaveLength(4);
  });

  it('with --dry-run says what it would remove and removes nothing', async () => {
    const { stdout } = await run(['--head', OWNER, '--dry-run']);
    expect(stdout).toContain('real producers kept on n8n');
    expect(stdout).toContain('mail: 2 cards');
    expect(stdout).toContain('n8n: 1 card (its demo cards only)');
    expect(stdout).toContain('dry run: nothing removed');
    expect(await ids()).toHaveLength(4);
  });

  it('removes the demo cards and tokens, every card of a root no real producer holds, and nothing of a real producer', async () => {
    await run(['--head', OWNER]);
    expect(await ids()).toEqual(['n8n:prices:1']);
    const tokens = await testDb().select({ root: producerTokens.root, instance: producerTokens.instance }).from(producerTokens).where(eq(producerTokens.headId, OWNER));
    expect(tokens).toEqual([{ root: 'n8n', instance: null }]);
    expect(await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.producer, 'mail')))).toEqual([]);
  });
});
