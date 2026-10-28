// pnpm demo:purge --head <owner> [--dry-run] — removes what `pnpm demo` left on a head: the demo producers' cards and
// their tokens. The demo's roots (scripts/demo-data.ts) are names real connectors use too, so a real producer is left
// alone: a root that holds a live token other than the demo's is a real producer's, and on it only the demo's own cards
// go (namespace `demo`, and the demo orders with the executors' cards in their threads). A root no real producer holds
// loses every card, earlier demo runs' included. The demo's tokens (instance `demo`) are deleted either way. Decisions
// on removed cards go from the decision log with them. `--dry-run` says what it would remove and removes nothing.
//
// Run it with the deployment's DATABASE_URL.

import { and, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { cards, decisionLog, producerTokens } from '../db/schema';
import { DEMO_INSTANCE, DEMO_MARK, DEMO_NAMESPACE, DEMO_ROOTS } from './demo-data';

const { values } = parseArgs({ options: { head: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
const head = values.head;
if (!head) {
  console.error('usage: pnpm demo:purge --head <owner> [--dry-run]   (refuses to run without --head)');
  process.exit(2);
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const dry = values['dry-run'];
const db = openDb(process.env.DATABASE_URL, 1);
const roots = Object.keys(DEMO_ROOTS);

try {
  // A root with a live token that is not the demo's belongs to a real producer.
  const live = await db
    .select({ root: producerTokens.root })
    .from(producerTokens)
    .where(and(eq(producerTokens.headId, head), inArray(producerTokens.root, roots), isNull(producerTokens.revokedAt), or(isNull(producerTokens.instance), ne(producerTokens.instance, DEMO_INSTANCE))));
  const real = new Set(live.map((t) => t.root));
  const demoOnly = roots.filter((r) => !real.has(r));

  const orders = (
    await db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.headId, head), eq(cards.producer, 'head'), eq(cards.namespace, 'order'), like(sql`${cards.producerDoc}->>'body'`, `%${DEMO_MARK}%`)))
  ).map((o) => o.id);
  const doomed = await db
    .select({ id: cards.id, producer: cards.producer })
    .from(cards)
    .where(
      and(
        eq(cards.headId, head),
        or(
          and(inArray(cards.producer, roots), eq(cards.namespace, DEMO_NAMESPACE)),
          demoOnly.length ? inArray(cards.producer, demoOnly) : sql`false`,
          orders.length ? inArray(cards.id, orders) : sql`false`,
          orders.length ? inArray(sql`${cards.producerDoc}->>'thread'`, orders) : sql`false`,
        ),
      ),
    );
  const tokens = await db
    .select({ root: producerTokens.root })
    .from(producerTokens)
    .where(and(eq(producerTokens.headId, head), inArray(producerTokens.root, roots), eq(producerTokens.instance, DEMO_INSTANCE)));

  const by = new Map<string, number>();
  for (const c of doomed) by.set(c.producer, (by.get(c.producer) ?? 0) + 1);
  console.log(`head ${head}: real producers kept on ${[...real].sort().join(', ') || 'no demo root'}`);
  for (const [producer, n] of [...by.entries()].sort()) console.log(`  ${producer}: ${n} card${n === 1 ? '' : 's'}${real.has(producer) ? ' (its demo cards only)' : ''}`);
  console.log(`  ${tokens.length} demo token${tokens.length === 1 ? '' : 's'}`);

  if (dry) {
    console.log('dry run: nothing removed');
  } else {
    const ids = doomed.map((c) => c.id);
    await db.transaction(async (tx) => {
      if (ids.length) {
        await tx.delete(decisionLog).where(and(eq(decisionLog.headId, head), inArray(decisionLog.cardId, ids)));
        await tx.delete(cards).where(and(eq(cards.headId, head), inArray(cards.id, ids)));
      }
      await tx.delete(producerTokens).where(and(eq(producerTokens.headId, head), inArray(producerTokens.root, roots), eq(producerTokens.instance, DEMO_INSTANCE)));
    });
    console.log(`removed ${ids.length} cards and ${tokens.length} demo tokens`);
  }
} finally {
  await db.$client.end();
}
