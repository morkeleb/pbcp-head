// The protocol operations, each one transaction: load → call @pbcp/core → apply its `changed[]` with
// fresh change_seq values → return what the route responds with. The rules themselves (equality,
// lifecycle, supersession, decision values) are @pbcp/core's; nothing here decides them.

import {
  acknowledge, CARD_LIMIT_BYTES, checkSubmission, decide, markSeen, parseCardOrThrow, PbcpError, producerPart,
  submit, type Card, type Decision, type Urgency,
} from '@pbcp/core';
import { and, asc, eq, gt, max } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cards, decisionLog } from '../db/schema';
import { now } from './clock';
import { decodeId } from './http';
import { load, persist, toCard, writeTx, type Stored, type Tx } from './store';

export interface Outcome {
  status: number;
  card: Card;
}

// --- submit (§7.1) ----------------------------------------------------------

const URGENCY_ORDER: readonly Urgency[] = ['log', 'brief', 'immediate'];

/** §9: the card's urgency clamped to the producer's ceiling. The stored producer document keeps the original (§4.1). */
export function clampUrgency(requested: Urgency | undefined, ceiling: Urgency): Urgency {
  const r = requested ?? 'brief';
  return URGENCY_ORDER.indexOf(r) > URGENCY_ORDER.indexOf(ceiling) ? ceiling : r;
}

/** Bytes of the card's JSON wire form (§3.1 "Size"); whitespace in the request does not count against it. */
function wireBytes(raw: string): number {
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= CARD_LIMIT_BYTES || raw.trimStart().startsWith('---')) return bytes;
  try {
    return Buffer.byteLength(JSON.stringify(JSON.parse(raw)), 'utf8');
  } catch {
    return bytes;
  }
}

export interface SubmitContext {
  headId: string;
  root: string;
  ceiling: Urgency;
}

/**
 * `PUT /cards/{id}`. The refusal order of §7.1: 401 is the route's (before this is called), then 413, then
 * the 400s of parsing, then 403, then the supersession checks and the §5 submission table inside `submit`.
 */
export async function submitCard(db: Db, ctx: SubmitContext, raw: string, rawPathId: string): Promise<Outcome> {
  if (wireBytes(raw) > CARD_LIMIT_BYTES) throw new PbcpError('too_large', `a card may be at most ${CARD_LIMIT_BYTES} bytes`);
  const incoming = parseCardOrThrow(raw);
  // The head's id is its owner's person id (§10).
  checkSubmission(incoming, { root: ctx.root, owner: ctx.headId, pathId: decodeId(rawPathId) });

  return writeTx(db, ctx.headId, async (tx) => {
    const stored = await load(tx, ctx.headId, incoming.id);
    const target = incoming.supersedes === undefined ? null : await load(tx, ctx.headId, incoming.supersedes);
    const r = submit(stored?.card ?? null, incoming, now(), target?.card ?? null);
    let card = r.card;
    for (const c of r.changed) {
      const urgency = c.id === incoming.id ? clampUrgency(incoming.urgency, ctx.ceiling) : (target as Stored).urgency;
      const saved = await persist(tx, ctx.headId, c, { urgency });
      if (c.id === incoming.id) card = saved;
    }
    return { status: r.status, card };
  });
}

// --- sync (§7.2) ------------------------------------------------------------

export interface SyncPage {
  changes: Array<{ seq: number; card: Card }>;
  next: number;
}

/**
 * `GET /changes?after=`. Entries are the caller's cards with change_seq > after, ascending. `next` is the
 * highest global change_seq examined: the global maximum above `after` when the page is not full, the
 * last entry's seq when it is, and `after` itself when nothing is newer. Both reads share one snapshot.
 */
export async function syncChanges(db: Db, ctx: { headId: string; root: string }, after: number, pageSize: number): Promise<SyncPage> {
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(cards)
        .where(and(eq(cards.headId, ctx.headId), eq(cards.producer, ctx.root), gt(cards.changeSeq, after)))
        .orderBy(asc(cards.changeSeq))
        .limit(pageSize);
      const changes = rows.map((row) => ({ seq: row.changeSeq, card: toCard(row) }));
      if (changes.length === pageSize) return { changes, next: changes.at(-1)!.seq };
      const [top] = await tx
        .select({ seq: max(cards.changeSeq) })
        .from(cards)
        .where(and(eq(cards.headId, ctx.headId), gt(cards.changeSeq, after)));
      return { changes, next: top?.seq ?? after };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** The `after` query parameter: absent means 0; anything but a non-negative integer is a 400. */
export function parseAfter(value: string | null): number {
  if (value === null || value === '') return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    // §7.4 has no code for a malformed sync cursor; invalid_card is the nearest 400 code.
    throw new PbcpError('invalid_card', 'after must be a non-negative integer change_seq');
  }
  return Number(value);
}

// --- owner-side operations (§7.3, §4.2) -------------------------------------

/** Who acted on the owner's behalf: the signed-in device (mobile PRD, Auth decision 4). */
export interface OwnerContext {
  headId: string;
  actor: string;
}

async function loadOrThrow(tx: Tx, headId: string, id: string): Promise<Stored> {
  const stored = await load(tx, headId, id);
  if (!stored) throw new PbcpError('not_found', `no card ${id}`);
  return stored;
}

/** `POST /cards/{id}/decision` (§7.3): decide, freeze the decided version, append to the decision log. */
export async function decideCard(db: Db, ctx: OwnerContext, id: string, body: unknown): Promise<Outcome> {
  return writeTx(db, ctx.headId, async (tx) => {
    const stored = await loadOrThrow(tx, ctx.headId, id);
    const at = now();
    const r = decide(stored.card, body as Decision, at);
    let card = r.card;
    for (const c of r.changed) {
      const decidedDoc = producerPart(stored.card);
      card = await persist(tx, ctx.headId, c, { decidedDoc });
      await tx.insert(decisionLog).values({
        headId: ctx.headId,
        cardId: card.id,
        decision: card.decision!,
        editedProposal: card.edited_proposal ?? null,
        comment: card.comment ?? null,
        delegatedTo: card.delegated_to ?? null,
        decidedAt: new Date(at),
        decidedDoc,
        actor: ctx.actor,
      });
    }
    return { status: r.status, card };
  });
}

/** The owner was shown the card (§4.2 `seen_at`). */
export async function markCardSeen(db: Db, ctx: OwnerContext, id: string): Promise<Outcome> {
  return ownerUpdate(db, ctx, id, (c) => markSeen(c, now()));
}

/** The owner explicitly acknowledged an artifact or signal (§4.2 `acknowledged_at`). */
export async function acknowledgeCard(db: Db, ctx: OwnerContext, id: string): Promise<Outcome> {
  return ownerUpdate(db, ctx, id, (c) => acknowledge(c, now()));
}

async function ownerUpdate(db: Db, ctx: OwnerContext, id: string, op: (c: Card) => { status: number; card: Card; changed: Card[] }): Promise<Outcome> {
  return writeTx(db, ctx.headId, async (tx) => {
    const stored = await loadOrThrow(tx, ctx.headId, id);
    const r = op(stored.card);
    let card = r.card;
    for (const c of r.changed) card = await persist(tx, ctx.headId, c);
    return { status: r.status, card };
  });
}
