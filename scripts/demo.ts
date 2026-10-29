// pnpm demo <head> [--url https://…] [--remove] — fills a head with example cards, one or more from each of
// the connectors in morkeleb/pbcp (caldav, goalpath, hermes, imap, n8n, obsidian-daily, todoist), shaped as
// those connectors make them, so the brief, the day view, threads, diagrams and orders have something to show. The
// cards and what happens to them are lib/demo/scenario.ts, which the front door's demo brief replays too.
//
// Everything goes through the head's HTTP API (--url, default WEBAUTHN_ORIGIN): the cards are PUT with producer
// tokens and the owner's actions use a session, so the head renders, folds and orders them exactly as it would
// real ones. The database is used only to mint those credentials, which are revoked when the script ends.
// Every demo card's id has `demo` as its namespace (`goalpath:demo:…`), and every demo order says so in its
// body; `--remove` deletes them all, with the executors' cards in their threads. The roots it seeds are in
// lib/demo/data.ts; `pnpm demo:purge` also removes their tokens and the cards of roots no real producer holds.
//
// Run it with the deployment's DATABASE_URL and SESSION_SECRET (docs/deploy.md, "Demo data").

import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { cards, decisionLog, devices, producerTokens } from '../db/schema';
import { mintProducerToken } from '../lib/auth/producer';
import { startSession } from '../lib/auth/session';
import { effectiveTimezone } from '../lib/timezone';
import { localDate } from '../lib/time';
import { DEMO_INSTANCE, DEMO_MARK, DEMO_NAMESPACE, DEMO_ROOTS, type DemoRoot } from '../lib/demo/data';
import { demoScenario } from '../lib/demo/scenario';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { url: { type: 'string' }, remove: { type: 'boolean', default: false } } });
const [head] = positionals;
const base = (values.url ?? process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
if (!head) {
  console.error('usage: pnpm demo <head> [--url https://head.example] [--remove]');
  process.exit(2);
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const db = openDb(process.env.DATABASE_URL, 1);

async function remove() {
  const orders = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.headId, head!), eq(cards.producer, 'head'), eq(cards.namespace, 'order'), like(sql`${cards.producerDoc}->>'body'`, `%${DEMO_MARK}%`)));
  const orderIds = orders.map((o) => o.id);
  const doomed = await db
    .select({ id: cards.id })
    .from(cards)
    .where(
      and(
        eq(cards.headId, head!),
        or(eq(cards.namespace, DEMO_NAMESPACE), orderIds.length ? inArray(cards.id, orderIds) : sql`false`, orderIds.length ? inArray(sql`${cards.producerDoc}->>'thread'`, orderIds) : sql`false`),
      ),
    );
  const ids = doomed.map((d) => d.id);
  if (ids.length) {
    await db.delete(decisionLog).where(and(eq(decisionLog.headId, head!), inArray(decisionLog.cardId, ids)));
    await db.delete(cards).where(and(eq(cards.headId, head!), inArray(cards.id, ids)));
  }
  console.log(`removed ${ids.length} demo cards (${orderIds.length} orders)`);
}

async function seed() {
  const { timezone } = await effectiveTimezone(db, head!);
  const today = localDate(new Date(), timezone);
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Credentials, minted the way `pnpm mint-token` does, and revoked at the end.
  const tokens: Record<string, string> = {};
  for (const [root, opts] of Object.entries(DEMO_ROOTS)) tokens[root] = await mintProducerToken(db, { headId: head!, root, instance: DEMO_INSTANCE, ...opts });
  const session = await startSession(db, { headId: head!, identityId: null, platform: 'web', name: 'demo seed' });
  const owner = `Session ${session.access_token}`;

  async function http(method: string, path: string, auth: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const put = (root: DemoRoot, card: Record<string, unknown> & { id: string }) =>
    http('PUT', `/api/cards/${encodeURIComponent(card.id)}`, `Bearer ${tokens[root]}`, { protocol: 'pbcp/1', producer: root, to_person: head, emitted_at: now(), ...card });

  try {
    // The scenario (lib/demo/scenario.ts), step by step, as each producer and the owner would.
    let cards = 0;
    let orders = 0;
    for (const step of demoScenario(today, timezone)) {
      if ('put' in step) {
        await put(step.put, step.card);
        cards++;
      } else if ('decide' in step) {
        await http('POST', `/api/me/cards/${encodeURIComponent(step.decide)}/decision`, owner, { decision: step.decision });
      } else {
        const order = await http('POST', '/api/me/orders', owner, { to_producer: step.order.to, title: step.order.title, body: step.order.body });
        orders++;
        const { root, steps, done } = step.work;
        const claim = await http('POST', `/api/cards/${encodeURIComponent(order.id)}/claim`, `Bearer ${tokens[root]}`, { lease_seconds: done ? 300 : 86_400 });
        const key = order.id.split(':')[2];
        const s = claim.claim_seq as number;
        for (const [i, note] of steps.entries()) {
          await put(root, { id: `${root}:order:${key}:progress-${s}-${i + 1}`, kind: 'signal', urgency: 'log', thread: order.id, references: [order.id], title: note.split('\n')[0], body: note });
        }
        if (done) await put(root, { id: `${root}:order:${key}:outcome-${s}`, kind: 'signal', thread: order.id, references: [order.id], 'orders.claim_seq': s, 'orders.result': 'done', title: done.title, body: done.body });
      }
    }
    console.log(`seeded ${head} at ${base}: ${cards} cards from ${Object.keys(DEMO_ROOTS).join(', ')}; ${orders} orders`);
    console.log('remove with: pnpm demo', head, '--remove');
  } finally {
    // No credentials outlive the script.
    await db.update(producerTokens).set({ revokedAt: new Date() }).where(and(eq(producerTokens.headId, head!), eq(producerTokens.instance, DEMO_INSTANCE)));
    await db.update(devices).set({ revokedAt: new Date(), refreshTokenHash: null }).where(eq(devices.id, session.device_id));
  }
}

try {
  await (values.remove ? remove() : seed());
} finally {
  await db.$client.end();
}
