// The human API's reads (docs/mobile-prd.md "Human API"): what the owner's devices show. Cards come back in
// the producer API's JSON shape plus `rendered_html` (and the rendered option bodies and first visual), so
// one card type serves the web and the phone. Nothing here is visible to producers.

import type { Card } from '@pbcp/core';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cards, changeCounter, devices, heads, producerTokens } from '../db/schema';
import { iso, now } from './clock';
import { HttpError } from './http';
import { renderCard, renderSource, type RenderMeta } from './render';
import type { Visual } from './render/markdown';
import { toCard } from './store';
import { dayRange, isDate, localDate } from './time';

type Row = typeof cards.$inferSelect;

export type MeCard = Card & {
  rendered_html: string;
  rendered_actions?: Record<string, string>;
  first_visual?: Visual;
};

/** A card for the owner: renders it first if its stored render is missing or stale (§3.1, render on receipt). */
export async function presentCards(db: Db, rows: Row[]): Promise<MeCard[]> {
  const out: MeCard[] = [];
  for (const row of rows) {
    const card = toCard(row);
    let html = row.renderedHtml;
    let actions = row.renderedActions as Record<string, string> | null;
    let meta = row.renderedMeta as RenderMeta | null;
    if (html === null || row.renderedFrom !== renderSource(card)) {
      const r = await renderCard(db, row.headId, card);
      ({ html, actions, meta } = r);
    }
    // TODO(pbcp-0.4): @pbcp/core 0.4 makes the clamped urgency a head-owned `delivery` field; once
    // toCard emits it from cards.urgency this representation carries it without change here.
    out.push({
      ...card,
      rendered_html: html,
      ...(actions && Object.keys(actions).length > 0 ? { rendered_actions: actions } : {}),
      ...(meta?.firstVisual ? { first_visual: meta.firstVisual } : {}),
    });
  }
  return out;
}

export async function headSettings(db: Db, headId: string) {
  const [head] = await db.select().from(heads).where(eq(heads.id, headId));
  if (!head) throw new HttpError(404, 'not_found', 'no such head');
  return head;
}

async function counter(db: Db, headId: string): Promise<number> {
  const [row] = await db.select({ seq: changeCounter.seq }).from(changeCounter).where(eq(changeCounter.headId, headId));
  return row?.seq ?? 0;
}

const notSnoozed = (at: Date): SQL => or(isNull(cards.snoozedUntil), lte(cards.snoozedUntil, at))!;

// --- the brief -----------------------------------------------------------------

export interface Fold {
  producer: string;
  thread: string | null;
  count: number;
  /** The newest card of the thread, in full; the others are listed (§8: a head MAY collapse all but the newest). */
  latest: MeCard;
  cards: Array<{ id: string; title: string; kind: string; received_at: string; acknowledged_at?: string }>;
}

/**
 * GET /api/me/brief: the current `head:daily` card, open decisions newest first, today's artifacts and
 * signals folded by thread, and the last-visit cursor. One call paints the Brief screen.
 *
 * - Open decisions are listed whatever their urgency (§9: a decision stays reachable until decided).
 * - Artifacts and signals are today's (head timezone), open, delivered at `brief` or `immediate` after the
 *   ceiling; `log` cards are for the day view only (§9). Immediate threads come first.
 * - Snoozed cards are left out until their time; `snoozed` counts them.
 * - `new` lists the ids changed since the last visit; `seq` is the head's counter now, which the client
 *   posts to /api/me/visit when the owner leaves.
 */
export async function brief(db: Db, headId: string) {
  const head = await headSettings(db, headId);
  const at = new Date(now());
  const today = localDate(at, head.timezone);
  const [start] = dayRange(today, head.timezone);
  const seq = await counter(db, headId);

  const [daily] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.producer, 'head'), eq(cards.namespace, 'daily'), lte(cards.id, `head:daily:${today}`)))
    .orderBy(desc(cards.id))
    .limit(1);

  const decisions = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), sql`${cards.producerDoc}->>'kind' = 'decision'`, notSnoozed(at)))
    .orderBy(desc(cards.receivedAt), desc(cards.changeSeq))
    .limit(200);

  const attention = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.headId, headId),
        eq(cards.state, 'open'),
        sql`${cards.producerDoc}->>'kind' in ('artifact', 'signal')`,
        inArray(cards.urgency, ['brief', 'immediate']),
        ne(cards.producer, 'head'),
        gte(cards.receivedAt, start),
        notSnoozed(at),
      ),
    )
    .orderBy(asc(cards.changeSeq));

  const [{ snoozed }] = (await db
    .select({ snoozed: sql<number>`count(*)::int` })
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), gt(cards.snoozedUntil, at)))) as [{ snoozed: number }];

  // Fold by producer and thread; a card without a thread is its own fold.
  const groups = new Map<string, Row[]>();
  for (const row of attention) {
    const thread = (row.producerDoc as { thread?: string }).thread;
    const key = `${row.producer}\u0000${thread ?? `\u0001${row.id}`}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const folds: Array<Fold & { immediate: boolean; order: number }> = [];
  for (const rows of groups.values()) {
    const newest = rows.at(-1)!;
    const [latest] = await presentCards(db, [newest]);
    folds.push({
      producer: newest.producer,
      thread: (newest.producerDoc as { thread?: string }).thread ?? null,
      count: rows.length,
      latest: latest!,
      cards: rows.map((r) => ({
        id: r.id,
        title: (r.producerDoc as { title: string }).title,
        kind: (r.producerDoc as { kind: string }).kind,
        received_at: iso(r.receivedAt),
        ...(r.acknowledgedAt ? { acknowledged_at: iso(r.acknowledgedAt) } : {}),
      })),
      immediate: rows.some((r) => r.urgency === 'immediate'),
      order: newest.changeSeq,
    });
  }
  folds.sort((a, b) => Number(b.immediate) - Number(a.immediate) || b.order - a.order);

  const shown = [...decisions, ...attention, ...(daily ? [daily] : [])];
  return {
    date: today,
    timezone: head.timezone,
    seq,
    last_visit: { seq: head.lastVisitSeq, at: head.lastVisitAt ? iso(head.lastVisitAt) : null },
    daily: daily ? (await presentCards(db, [daily]))[0]! : null,
    decisions: await presentCards(db, decisions),
    threads: folds.map(({ immediate: _i, order: _o, ...f }) => f),
    snoozed,
    new: shown.filter((r) => r.changeSeq > head.lastVisitSeq).map((r) => r.id),
  };
}

// --- cards by day ----------------------------------------------------------------

export interface CardQuery {
  date?: string | null;
  since?: string | null;
  until?: string | null;
  state?: string | null;
  after?: string | null;
  limit?: string | null;
}

/**
 * GET /api/me/cards: cards received in a window — a local day (`date`, the Day screen) or `since`/`until`
 * instants — optionally of one `state`, in change_seq order, paginated by change_seq (`after`, `next`).
 */
export async function listCards(db: Db, headId: string, q: CardQuery) {
  const head = await headSettings(db, headId);
  const where: SQL[] = [eq(cards.headId, headId)];
  if (q.date) {
    if (!isDate(q.date)) throw new HttpError(400, 'invalid_request', 'date must be YYYY-MM-DD');
    const [start, end] = dayRange(q.date, head.timezone);
    where.push(gte(cards.receivedAt, start), lt(cards.receivedAt, end));
  }
  for (const [key, op] of [['since', gte], ['until', lt]] as const) {
    const v = q[key];
    if (!v) continue;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_request', `${key} must be an RFC 3339 timestamp`);
    where.push(op(cards.receivedAt, d));
  }
  if (q.state) {
    if (!['open', 'decided', 'superseded'].includes(q.state)) throw new HttpError(400, 'invalid_request', 'state must be open, decided or superseded');
    where.push(eq(cards.state, q.state));
  }
  const after = q.after ? Number(q.after) : 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'invalid_request', 'after must be a change_seq');
  where.push(gt(cards.changeSeq, after));
  const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);

  const rows = await db.select().from(cards).where(and(...where)).orderBy(asc(cards.changeSeq)).limit(limit);
  return { cards: await presentCards(db, rows), next: rows.length === limit ? rows.at(-1)!.changeSeq : null, timezone: head.timezone };
}

// --- one card with its thread --------------------------------------------------------

async function rowsById(db: Db, headId: string, ids: string[]): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(cards).where(and(eq(cards.headId, headId), inArray(cards.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * GET /api/me/cards/{id}: the card, the chain it supersedes (oldest first) and the chain that supersedes it,
 * its references resolved (null when this head does not hold one), and every card of its thread, newest last.
 */
export async function cardWithThread(db: Db, headId: string, id: string) {
  const [row] = await db.select().from(cards).where(and(eq(cards.headId, headId), eq(cards.id, id)));
  if (!row) throw new HttpError(404, 'not_found', `no card ${id}`);

  const predecessors: Row[] = [];
  const seen = new Set([row.id]);
  for (let ref = (row.producerDoc as { supersedes?: string }).supersedes; ref && !seen.has(ref); ) {
    seen.add(ref);
    const prev = (await rowsById(db, headId, [ref])).get(ref);
    if (!prev) break;
    predecessors.unshift(prev);
    ref = (prev.producerDoc as { supersedes?: string }).supersedes;
  }
  const successors: Row[] = [];
  for (let cur = row.id; ; ) {
    const [next] = await db
      .select()
      .from(cards)
      .where(and(eq(cards.headId, headId), eq(cards.producer, row.producer), sql`${cards.producerDoc}->>'supersedes' = ${cur}`))
      .limit(1);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    successors.push(next);
    cur = next.id;
  }

  const refs = ((row.producerDoc as { references?: string[] }).references ?? []).slice(0, 100);
  const referenced = await rowsById(db, headId, refs);

  const thread = (row.producerDoc as { thread?: string }).thread;
  const threadRows = thread
    ? await db
        .select()
        .from(cards)
        .where(and(eq(cards.headId, headId), eq(cards.producer, row.producer), sql`${cards.producerDoc}->>'thread' = ${thread}`))
        .orderBy(asc(cards.receivedAt), asc(cards.changeSeq))
        .limit(200)
    : [];

  const summary = (r: Row) => {
    const c = toCard(r);
    return { id: c.id, title: c.title, kind: c.kind, state: c.state, received_at: c.received_at, ...(c.decision ? { decision: c.decision } : {}) };
  };
  return {
    card: (await presentCards(db, [row]))[0]!,
    predecessors: await presentCards(db, predecessors),
    successors: successors.map(summary),
    references: await Promise.all(refs.map(async (ref) => ({ id: ref, card: referenced.has(ref) ? summary(referenced.get(ref)!) : null }))),
    thread: threadRows.map(summary),
  };
}

// --- settings: producers and devices ---------------------------------------------------

export async function listProducers(db: Db, headId: string) {
  const tokens = await db.select().from(producerTokens).where(eq(producerTokens.headId, headId)).orderBy(asc(producerTokens.createdAt));
  const last = await db
    .select({ producer: cards.producer, at: sql<Date>`max(${cards.receivedAt})`.mapWith(cards.receivedAt) })
    .from(cards)
    .where(eq(cards.headId, headId))
    .groupBy(cards.producer);
  const lastAt = new Map(last.map((l) => [l.producer, l.at]));
  const roots = [...new Set(tokens.map((t) => t.root))];
  return roots.map((root) => {
    const mine = tokens.filter((t) => t.root === root);
    const active = mine.filter((t) => t.revokedAt === null);
    const newest = active.at(-1) ?? mine.at(-1)!;
    const at = lastAt.get(root);
    return {
      root,
      ceiling: newest.urgencyCeiling,
      executor: newest.executor,
      revoked: active.length === 0,
      tokens: mine.map((t) => ({
        instance: t.instance,
        ceiling: t.urgencyCeiling,
        executor: t.executor,
        created_at: iso(t.createdAt),
        ...(t.revokedAt ? { revoked_at: iso(t.revokedAt) } : {}),
      })),
      last_card_at: at ? iso(at) : null,
    };
  });
}

export async function listDevices(db: Db, headId: string, current: string) {
  const rows = await db
    .select()
    .from(devices)
    .where(and(eq(devices.headId, headId), isNull(devices.revokedAt)))
    .orderBy(desc(devices.lastSeenAt));
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    created_at: iso(d.createdAt),
    last_seen_at: d.lastSeenAt ? iso(d.lastSeenAt) : null,
    current: d.id === current,
  }));
}
