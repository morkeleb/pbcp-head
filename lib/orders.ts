// The orders extension (RFC Appendix A). Like lib/protocol.ts: each operation is one transaction that loads,
// calls @pbcp/core (mintOrder, expireIfDue, claim, applyOutcome, visibleTo) and persists `changed[]` with fresh
// change_seq values. The head owns the lease clock (`now()`); expiry is lazy, applied before any read or write
// that involves an order (OPEN, Orders 15), because the head runs no worker.

import {
  applyOutcome, checkLease, claim, ClaimRefusal, expireIfDue, isOrder, mintOrder, PbcpError, ulid, visibleTo,
  type Card, type OrderCard, type OrderInput, type ProducerCard,
} from '@pbcp/core';
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client';
import { cards, producerTokens } from '../db/schema';
import { now } from './clock';
import { decodeId } from './http';
import type { Outcome } from './protocol';
import { load, persist, toCard, writeTx, type Tx } from './store';

/** A head-chosen upper bound on a lease (OPEN, Orders 10: "the upper bound is the head's"). One day. */
export const MAX_LEASE_SECONDS = 24 * 60 * 60;

/** The executors the head trusts for `to_producer: *` right now: roots with a live token flagged executor (A.1). */
async function executors(tx: Tx, headId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ root: producerTokens.root })
    .from(producerTokens)
    .where(and(eq(producerTokens.headId, headId), eq(producerTokens.executor, true), isNull(producerTokens.revokedAt)));
  return rows.map((r) => r.root);
}

/** A.1: the owner gives an order; the head mints `head:order:<ulid>`, snapshotting wildcard eligibility. */
export async function giveOrder(db: Db, headId: string, input: OrderInput): Promise<Card> {
  return writeTx(db, headId, async (tx) => {
    const at = now();
    const { order, eligible } = mintOrder(input, { ulid: ulid(Date.parse(at), randomBytes(10)), now: at, executors: await executors(tx, headId) });
    return persist(tx, headId, order, { eligible });
  });
}

/**
 * The owner's record of an order's lease (head-private columns, never synced): a new claim (its `claim_seq` moved)
 * starts it afresh, a renewal (the same claim, held on) counts once more, and a lease that expires with no outcome
 * leaves the time it lapsed, which core drops from the order with the lease (A.2).
 */
async function recordLease(tx: Tx, headId: string, before: OrderCard, after: OrderCard, at: string): Promise<void> {
  const where = and(eq(cards.headId, headId), eq(cards.id, after.id));
  if (after.exec_state === 'claimed' && after.claim_seq !== before.claim_seq) {
    await tx.update(cards).set({ leaseClaimedAt: new Date(at), leaseRenewals: 0, leaseLapsedAt: null }).where(where);
  } else if (after.exec_state === 'claimed' && before.exec_state === 'claimed') {
    await tx.update(cards).set({ leaseRenewals: sql`${cards.leaseRenewals} + 1` }).where(where);
  } else if (before.exec_state === 'claimed' && after.exec_state === 'open' && before.claim_expires_at) {
    await tx.update(cards).set({ leaseLapsedAt: new Date(before.claim_expires_at) }).where(where);
  }
}

/** A.2: every claimed order whose lease is at or before now returns to `open`, each with a new change_seq. */
export async function expireDueOrders(db: Db, headId: string): Promise<void> {
  const at = now();
  const due = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.execState, 'claimed'), lte(cards.claimExpiresAt, new Date(at))));
  if (due.length === 0) return;
  await writeTx(db, headId, async (tx) => {
    for (const { id } of due) {
      const o = await load(tx, headId, id, { forUpdate: true });
      if (!o || !isOrder(o.card)) continue;
      const r = expireIfDue(o.card as unknown as OrderCard, at);
      for (const c of r.changed) await persist(tx, headId, c);
      await recordLease(tx, headId, o.card as unknown as OrderCard, r.card, at);
    }
  });
}

/**
 * `POST /cards/{id}/claim { lease_seconds }` (A.2, A.5): the row is locked, expiry is evaluated inside the same
 * lock, then core's claim decides. 200 claims or renews (a renewal keeps `claim_seq`); a refusal is core's
 * `ClaimRefusal`, `{ error, message, order }`: 409 `lease_held`, 410 `order_terminal`. It is thrown once the
 * transaction has committed, so an expiry evaluated on the way is kept. An order the caller cannot read, or a
 * card that is not an order, is 404 (A.2); a bad `lease_seconds` is 400 `invalid_lease`.
 */
export async function claimOrder(db: Db, producer: { headId: string; root: string }, rawId: string, body: unknown): Promise<Outcome> {
  const id = decodeId(rawId);
  const r = await writeTx(db, producer.headId, async (tx) => {
    const stored = await load(tx, producer.headId, id, { forUpdate: true });
    if (!stored || !isOrder(stored.card) || !visibleTo(stored.card as unknown as OrderCard, producer.root, stored.eligible)) {
      throw new PbcpError('not_found', `no order ${id} for ${producer.root}`);
    }
    const lease = checkLease((body as { lease_seconds?: unknown } | null)?.lease_seconds);
    if (lease > MAX_LEASE_SECONDS) throw new PbcpError('invalid_lease', `lease_seconds may be at most ${MAX_LEASE_SECONDS}`);
    const at = now();
    const r = claim(stored.card as unknown as OrderCard, producer.root, lease, at);
    let card: Card = stored.card;
    for (const c of r.changed) card = await persist(tx, producer.headId, c);
    // A claim on a lapsed lease expires it and claims afresh in one step; a refusal changes nothing to record.
    if (r.status === 200) await recordLease(tx, producer.headId, stored.card as unknown as OrderCard, r.card, at);
    return { status: r.status, card, refused: r.status === 200 ? undefined : r.code };
  });
  if (r.refused) throw new ClaimRefusal(r.refused, r.card as unknown as Record<string, unknown> & { id: string });
  return { status: r.status, card: r.card };
}

/**
 * A.3, inside the PUT's transaction, after the outcome card itself was stored (so it takes the lower
 * change_seq, the order the higher: OPEN, Orders 20). Expiry first; then core decides whether this outcome
 * comes from the current lease. Either way the outcome stays stored; the head marks it `applied` or `stale`,
 * and the brief surfaces stale ones as late or duplicate results.
 */
export async function applyOutcomeInTx(tx: Tx, headId: string, incoming: ProducerCard, target: string): Promise<void> {
  const o = await load(tx, headId, target, { forUpdate: true });
  if (!o || !isOrder(o.card)) return;
  const at = now();
  const expiry = expireIfDue(o.card as unknown as OrderCard, at);
  for (const c of expiry.changed) await persist(tx, headId, c);
  await recordLease(tx, headId, o.card as unknown as OrderCard, expiry.card, at);
  const r = applyOutcome(expiry.card, incoming, at);
  for (const c of r.changed) await persist(tx, headId, c);
  await tx.update(cards).set({ outcome: r.stale ? 'stale' : 'applied' }).where(and(eq(cards.headId, headId), eq(cards.id, incoming.id)));
}

/** The A.1 recipient rule for sync, as SQL: orders named to `root`, or `*` orders whose snapshot includes it. */
export const visibleOrders = (root: string) =>
  sql`(${cards.toProducer} = ${root} or (${cards.toProducer} = '*' and ${root} = any(${cards.wildcardEligible})))`;

/** Orders for the owner's Orders screen: active ones, and those that finished in the last week. */
export async function ordersFor(db: Db, headId: string) {
  await expireDueOrders(db, headId);
  const since = new Date(Date.parse(now()) - 7 * 24 * 3600 * 1000);
  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), isNotNull(cards.toProducer), or(inArray(cards.execState, ['open', 'claimed']), gte(cards.changedAt, since))))
    .orderBy(sql`${cards.receivedAt} desc`)
    .limit(200);
  return rows.map(toCard);
}
