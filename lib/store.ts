// Cards in Postgres. The row holds the ProducerCard as accepted (producer_doc) and the head-owned fields
// as columns; a Card is the two merged. Every write happens inside `writeTx`, which takes the head's
// change_counter row FOR UPDATE first, so writes to one head are serialised and commit in change_seq order.

import { parseId, producerPart, type Card, type ProducerCard } from '@pbcp/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cards, changeCounter } from '../db/schema';
import { iso } from './clock';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Row = typeof cards.$inferSelect;

/** A stored card with the head-side state that is not part of the protocol representation. */
export interface Stored {
  card: Card;
  urgency: string;
}

/** One transaction per protocol operation (CLAUDE.md): counter, card writes and decision log, all or nothing. */
export async function writeTx<T>(db: Db, headId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select seq from ${changeCounter} where ${changeCounter.headId} = ${headId} for update`);
    if (locked.length === 0) throw new Error(`head ${headId} has no change counter`);
    return fn(tx);
  });
}

/** The next value of the head's counter (§7.2). Only valid inside `writeTx`, which holds the row lock. */
export async function nextSeq(tx: Tx, headId: string): Promise<number> {
  const [row] = await tx
    .update(changeCounter)
    .set({ seq: sql`${changeCounter.seq} + 1` })
    .where(eq(changeCounter.headId, headId))
    .returning({ seq: changeCounter.seq });
  return row!.seq;
}

export async function load(tx: Tx | Db, headId: string, id: string): Promise<Stored | null> {
  const [row] = await tx.select().from(cards).where(and(eq(cards.headId, headId), eq(cards.id, id)));
  return row ? { card: toCard(row), urgency: row.urgency } : null;
}

export interface PersistOptions {
  /** Delivery urgency after the ceiling; required when the card is new. */
  urgency?: string;
  /** Freeze this producer document as the version decided on (§4.4). */
  decidedDoc?: ProducerCard;
}

/**
 * Writes one card returned in a core result's `changed[]` with a fresh change_seq from the counter, and
 * returns it as stored. Callers pass `changed[]` in order, so a supersession gives the predecessor the
 * lower value and the successor the higher (§7.2).
 */
export async function persist(tx: Tx, headId: string, card: Card, opts: PersistOptions = {}): Promise<Card> {
  const seq = await nextSeq(tx, headId);
  const stored: Card = { ...card, change_seq: seq };
  const head = headColumns(stored);
  const updated = await tx
    .update(cards)
    .set({
      producerDoc: producerPart(stored),
      ...head,
      ...(opts.urgency !== undefined ? { urgency: opts.urgency } : {}),
      ...(opts.decidedDoc !== undefined ? { decidedDoc: opts.decidedDoc } : {}),
    })
    .where(and(eq(cards.headId, headId), eq(cards.id, stored.id)))
    .returning({ id: cards.id });
  if (updated.length === 0) {
    if (opts.urgency === undefined) throw new Error(`a new card needs its delivery urgency: ${stored.id}`);
    const id = parseId(stored.id)!;
    await tx.insert(cards).values({
      headId,
      id: stored.id,
      producer: id.producer,
      namespace: id.namespace,
      producerDoc: producerPart(stored),
      urgency: opts.urgency,
      ...head,
      decidedDoc: opts.decidedDoc ?? null,
    });
  }
  return stored;
}

// --- mapping ----------------------------------------------------------------

const date = (s: string | undefined): Date | null => (s === undefined ? null : new Date(s));

function headColumns(c: Card) {
  return {
    state: c.state,
    changeSeq: c.change_seq,
    receivedAt: new Date(c.received_at),
    changedAt: new Date(c.changed_at),
    seenAt: date(c.seen_at),
    acknowledgedAt: date(c.acknowledged_at),
    snoozedUntil: date(c.snoozed_until),
    decision: c.decision ?? null,
    editedProposal: c.edited_proposal ?? null,
    comment: c.comment ?? null,
    decidedAt: date(c.decided_at),
    delegatedTo: c.delegated_to ?? null,
  };
}

/**
 * The protocol representation: producer fields as accepted, then the head-owned fields that are set. Unset fields are absent, never null.
 * TODO(pbcp-0.4): emit `delivery` (from cards.urgency) here once it is a head-owned field in @pbcp/core;
 * headColumns() then reads it back from the card instead of from PersistOptions.urgency.
 */
export function toCard(row: Row): Card {
  const out: Record<string, unknown> = {
    ...(row.producerDoc as ProducerCard),
    state: row.state,
    change_seq: row.changeSeq,
    received_at: iso(row.receivedAt),
    changed_at: iso(row.changedAt),
  };
  const optional: Record<string, unknown> = {
    seen_at: row.seenAt && iso(row.seenAt),
    acknowledged_at: row.acknowledgedAt && iso(row.acknowledgedAt),
    snoozed_until: row.snoozedUntil && iso(row.snoozedUntil),
    decision: row.decision,
    edited_proposal: row.editedProposal,
    comment: row.comment,
    decided_at: row.decidedAt && iso(row.decidedAt),
    delegated_to: row.delegatedTo,
    to_producer: row.toProducer,
    exec_state: row.execState,
    claimed_by: row.claimedBy,
    claim_expires_at: row.claimExpiresAt && iso(row.claimExpiresAt),
    claim_seq: row.claimSeq,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== null && v !== undefined) out[k] = v;
  return out as Card;
}
