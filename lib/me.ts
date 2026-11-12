// The human API's reads (docs/mobile-prd.md "Human API"): what the owner's devices show. Cards come back in
// the producer API's JSON shape plus `rendered_html` (and the rendered option bodies and first visual), so
// one card type serves the web and the phone. Nothing here is visible to producers.

import type { Card } from '@pbcp/core';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cards, changeCounter, decisionLog, devices, heads, producerTokens } from '../db/schema';
import { iso, now } from './clock';
import { HttpError } from './http';
import { expireDueOrders } from './orders';
import { currentFold } from './brief/fold-version';
import { composeParagraph, type ParagraphParts } from './brief/paragraph';
import { dailyParagraphNow } from './brief/nightly';
import { renderCard, renderSource, type RenderMeta } from './render';
import type { Visual } from './render/markdown';
import { openRows, replacedBy, toCard, type Successor } from './store';
import { dataKey } from './keys';
import { openLogRow, type OpenCardRow } from './vault';
import { effectiveTimezone } from './timezone';
import { addDays, byTime, dayRange, isDate, localDate } from './time';
import { byDue, isOverdue } from './brief/tasks';
import { formatTime } from './push/daily';
import { annotateParts, countLabels, effectiveOf, loadPolicy, type Sensitivity, type SensitivityPolicy } from './sensitivity';

type Row = OpenCardRow;

export type MeCard = Card & {
  rendered_html: string;
  /** The card's lead (RFC 0.6 §3.1, core's leadOf): the `summary` as text, or the body's first paragraph as markdown. */
  lead: string;
  lead_source: 'summary' | 'body';
  /** The lead as safe inline HTML: the summary escaped (cut at 280 characters), or the paragraph rendered inline. */
  rendered_lead: string;
  /** On an order's outcome card (A.3): whether it moved the order, or came late or from an old lease. */
  order_outcome?: 'applied' | 'stale';
  rendered_actions?: Record<string, string>;
  first_visual?: Visual;
  /** §8 the card's day: its `about`, else the day of `at`, else of received_at, in the head's timezone (YYYY-MM-DD). */
  day: string;
  /** On a `head:daily` card: its paragraph in parts, each entry with its card's labels, for filtering (lib/brief/paragraph.ts). */
  paragraph?: ParagraphParts;
  /** On a superseded card: the newest card of its successor chain (§8), which the owner is sent to instead. */
  replaced_by?: Successor;
  /** RFC 0.9 §9: the card's `sensitivity` raised by the owner's floors, as of this response; the card's own stays as sent. */
  effective_sensitivity: Sensitivity;
  /**
   * On a `head:daily` card with parts: its paragraph for a surface outside the signed-in session, in plain text, with
   * private and confirm entries counted, not named (RFC 0.9 §4.1). The card's body and lead name them; this does not.
   */
  spoken_paragraph?: string;
};

export type { Successor };

/** A card for the owner: renders it first if its stored render is missing or stale (§3.1, render on receipt). */
export async function presentCards(db: Db, rows: Row[]): Promise<MeCard[]> {
  const out: MeCard[] = [];
  const policies = new Map<string, SensitivityPolicy>();
  const policyOf = async (headId: string) => policies.get(headId) ?? policies.set(headId, await loadPolicy(db, headId)).get(headId)!;
  for (const row of rows) {
    const card = toCard(row);
    let html = row.renderedHtml;
    let actions = row.renderedActions as Record<string, string> | null;
    let meta = row.renderedMeta as RenderMeta | null;
    if (html === null || row.renderedFrom !== renderSource(card)) {
      const r = await renderCard(db, row.headId, card);
      ({ html, actions, meta } = r);
    }
    // §8: a superseded card names its newest successor, which the owner is sent to instead.
    const by = card.state === 'superseded' ? await replacedBy(db, row.headId, card) : null;
    const parts = row.renderedParagraph ? await annotateParts(db, row.headId, row.renderedParagraph as ParagraphParts, await policyOf(row.headId)) : null;
    out.push({
      ...card,
      rendered_html: html,
      lead: meta?.lead?.text ?? '',
      lead_source: meta?.lead?.source ?? 'body',
      rendered_lead: meta?.lead?.html ?? '',
      ...(actions && Object.keys(actions).length > 0 ? { rendered_actions: actions } : {}),
      ...(meta?.firstVisual ? { first_visual: meta.firstVisual } : {}),
      ...(row.outcome === 'applied' || row.outcome === 'stale' ? { order_outcome: row.outcome } : {}),
      day: row.day,
      ...(parts ? { paragraph: parts, spoken_paragraph: composeParagraph(parts, [], { spoken: true }) } : {}),
      ...(by ? { replaced_by: by } : {}),
      effective_sensitivity: effectiveOf(card, await policyOf(row.headId)),
    });
  }
  return out;
}

export async function rowsFor(db: Db, headId: string, ids: string[]): Promise<Row[]> {
  return [...(await rowsById(db, headId, ids)).values()];
}

const isOrderId = (id: string | undefined) => id !== undefined && id.startsWith('head:order:');

/**
 * An order's thread (A.3): the cards executors post under their own namespace with `thread` set to the order
 * id: progress signals and the outcome. Unlike a producer's thread it spans producers.
 */
async function orderThread(db: Db, headId: string, orderId: string): Promise<Row[]> {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), sql`${cards.producerDoc}->>'thread' = ${orderId}`))
    .orderBy(asc(cards.receivedAt), asc(cards.changeSeq))
    .limit(200).then((rows) => openRows(db, rows));
}

/** An order's lease as the owner sees it (head-private, A.2). */
const leaseOf = (r: Row) => ({
  claimed_at: r.leaseClaimedAt ? iso(r.leaseClaimedAt) : null,
  renewals: r.leaseRenewals,
  lapsed_at: r.leaseLapsedAt ? iso(r.leaseLapsedAt) : null,
});

const isOutcome = (r: Row) => (r.producerDoc as Record<string, unknown>)['orders.result'] !== undefined;

/**
 * /api/me/orders: each order with its lease as the owner sees it (when the current claim began, how often it was
 * renewed, when the last lease lapsed: head-private, A.2) and its thread (A.3): a count, the latest card in full, every
 * progress note newest first, and the latest outcome in full.
 */
export async function orderProgress(db: Db, headId: string, orders: Card[]) {
  const rows = await rowsFor(db, headId, orders.map((o) => o.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const presented = new Map((await presentCards(db, rows)).map((c) => [c.id, c]));
  return Promise.all(
    orders.map(async (o) => {
      const thread = await orderThread(db, headId, o.id);
      const latest = thread.at(-1);
      const outcome = thread.filter(isOutcome).at(-1);
      const row = byId.get(o.id);
      return {
        ...presented.get(o.id)!,
        lease: row ? leaseOf(row) : { claimed_at: null, renewals: 0, lapsed_at: null },
        progress: {
          count: thread.length,
          latest: latest ? (await presentCards(db, [latest]))[0]! : null,
          notes: thread.filter((r) => !isOutcome(r)).reverse().map((r) => ({ id: r.id, title: (r.producerDoc as { title: string }).title, received_at: iso(r.receivedAt) })),
          outcome: outcome ? (await presentCards(db, [outcome]))[0]! : null,
        },
      };
    }),
  );
}

/** The head's row, with `timezone` the effective zone (lib/timezone.ts) and `zone` how it was chosen. */
export async function headSettings(db: Db, headId: string) {
  const [head] = await db.select().from(heads).where(eq(heads.id, headId));
  if (!head) throw new HttpError(404, 'not_found', 'no such head');
  const zone = await effectiveTimezone(db, headId, head.timezone);
  return { ...head, timezone: zone.timezone, zone };
}

/** GET /api/me/seq: the change counter and the head's local date, which together say whether the brief is stale. */
export async function briefStamp(db: Db, headId: string): Promise<{ seq: number; date: string; settings_seq: number }> {
  const head = await headSettings(db, headId);
  const [h] = await db.select({ settingsSeq: heads.settingsSeq }).from(heads).where(eq(heads.id, headId));
  return { seq: await counter(db, headId), date: localDate(new Date(now()), head.timezone), settings_seq: h?.settingsSeq ?? 0 };
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
 * - Artifacts and signals are today's (the effective timezone), open, delivered at `brief` or `immediate` after the
 *   ceiling; `log` cards are only in a day's cards (GET /api/me/cards, the timeline's earlier days; §9). Immediate threads come first.
 * - Snoozed cards are left out until their time; `snoozed` counts them.
 * - `new` lists the ids changed since the last visit; `seq` is the head's counter now, which the client
 *   posts to /api/me/visit when the owner leaves.
 */
export interface BriefOptions {
  /**
   * `spoken=1`: the daily paragraph for a surface outside the owner's signed-in session (the owner MCP's `brief` tool, a
   * voice client): plain text, private and confirm entries counted, never named (RFC 0.9 §4.1). The parts and the card
   * lists are the same either way; each carries both sensitivities, so the client applies its own rules to them.
   */
  spoken?: boolean;
}

export async function brief(db: Db, headId: string, opts: BriefOptions = {}) {
  const head = await headSettings(db, headId);
  await expireDueOrders(db, headId); // A.2: lapsed leases are visible as lapsed before the brief reads them
  const at = new Date(now());
  const today = localDate(at, head.timezone);
  const seq = await counter(db, headId);

  const [daily] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.producer, 'head'), eq(cards.namespace, 'daily'), lte(cards.id, `head:daily:${today}`)))
    .orderBy(desc(cards.id))
    .limit(1).then((rows) => openRows(db, rows));

  const decisions = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), sql`${cards.producerDoc}->>'kind' = 'decision'`, notSnoozed(at)))
    .orderBy(desc(cards.receivedAt), desc(cards.changeSeq))
    .limit(200).then((rows) => openRows(db, rows));

  // §8, §4.5: every open task that is not snoozed and whose day is today or earlier (an earlier one is overdue), and the
  // tasks closed today: decided here (done, a listed action, dismissed) or superseded by the producer's record of what
  // came of them (§4.3: "Done in Todoist"), which stay, ticked, for the rest of the day. A task replaced by another task
  // is that one's to show.
  const [dayStart, dayEnd] = dayRange(today, head.timezone);
  const taskRows = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.headId, headId),
        sql`${cards.producerDoc}->>'kind' = 'task'`,
        or(
          and(eq(cards.state, 'open'), lte(cards.day, today), notSnoozed(at)),
          and(
            ne(cards.state, 'open'),
            or(
              and(gte(cards.decidedAt, dayStart), lt(cards.decidedAt, dayEnd)),
              // Superseded today: by when its successor arrived, not `changed_at`, which presenting or acknowledging moves.
              and(
                eq(cards.state, 'superseded'),
                sql`exists (select 1 from cards s where s.head_id = ${cards.headId} and s.producer = ${cards.producer} and s.producer_doc->>'supersedes' = ${cards.id} and s.received_at >= ${dayStart.toISOString()}::timestamptz and s.received_at < ${dayEnd.toISOString()}::timestamptz)`,
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(cards.receivedAt), asc(cards.id)) // ties in when they are due keep the order they came in
    .limit(200).then((rows) => openRows(db, rows));
  const counting = new Set(await countLabels(db, headId));
  const tasks = (await presentCards(db, taskRows))
    .filter((c) => c.state !== 'superseded' || c.replaced_by?.kind !== 'task')
    .sort(byDue(head.timezone))
    // §4.5: overdue as the head presents it now, on the response only; never a field of the card. §9 "Folding": a task
    // under a label the owner set to `count` is routine, grouped apart in the Tasks section; the card is unchanged.
    .map((c) => ({ ...c, ...(isOverdue(c, at, head.timezone) ? { overdue: true as const } : {}), ...((c.labels ?? []).some((l) => counting.has(l)) ? { routine: true as const } : {}) }));

  const attention = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.headId, headId),
        eq(cards.state, 'open'),
        sql`${cards.producerDoc}->>'kind' in ('artifact', 'signal')`,
        inArray(cards.delivery, ['brief', 'immediate']),
        ne(cards.producer, 'head'),
        eq(cards.day, today), // §8: today's cards are those whose day is today, `about`, `at` or received
        notSnoozed(at),
      ),
    )
    .orderBy(asc(cards.changeSeq)).then((rows) => openRows(db, rows));

  // Orders with progress or an outcome since the last visit (A.3): one row each in the brief, "<order> — <newest
  // card's lead>", which stands for those cards; an open order that has been quiet since has none. An outcome that
  // asks a decision is a decision card, and stays one.
  const news = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), sql`${cards.producerDoc}->>'thread' like 'head:order:%'`, sql`${cards.producerDoc}->>'kind' <> 'decision'`, gt(cards.changeSeq, head.lastVisitSeq)))
    .orderBy(asc(cards.changeSeq))
    .limit(500).then((rows) => openRows(db, rows));
  const newsByOrder = new Map<string, Row[]>();
  for (const r of news) {
    const order = (r.producerDoc as { thread: string }).thread;
    newsByOrder.set(order, [...(newsByOrder.get(order) ?? []), r]);
  }
  const openOrders = (await rowsFor(db, headId, [...newsByOrder.keys()])).filter((o) => o.toProducer !== null && o.state === 'open');
  const orderUpdates = await Promise.all(
    openOrders
      .map((o) => ({ o, rows: newsByOrder.get(o.id)! }))
      .sort((a, b) => b.rows.at(-1)!.changeSeq - a.rows.at(-1)!.changeSeq)
      .map(async ({ o, rows }) => ({ id: o.id, title: (o.producerDoc as { title: string }).title, count: rows.length, latest: (await presentCards(db, [rows.at(-1)!]))[0]! })),
  );
  const folded = new Set(orderUpdates.map((u) => u.id));
  const loose = attention.filter((r) => !folded.has((r.producerDoc as { thread?: string }).thread ?? ''));

  const [{ snoozed }] = (await db
    .select({ snoozed: sql<number>`count(*)::int` })
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), gt(cards.snoozedUntil, at)))) as [{ snoozed: number }];

  // Fold by producer and thread; a card without a thread is its own fold.
  const groups = new Map<string, Row[]>();
  for (const row of loose) {
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
      immediate: rows.some((r) => r.delivery === 'immediate'),
      order: newest.changeSeq,
    });
  }
  folds.sort((a, b) => Number(b.immediate) - Number(a.immediate) || b.order - a.order);

  // A.3: outcomes that came late or from an old lease are stored but did nothing; the owner should hear of them.
  const late = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.outcome, 'stale'), eq(cards.state, 'open'), isNull(cards.acknowledgedAt)))
    .orderBy(desc(cards.changeSeq))
    .limit(50).then((rows) => openRows(db, rows));
  // A.2: a lease that lapsed with no outcome usually means a worker died. The head surfaces those orders here
  // rather than minting a signal card per lapse.
  const lapsed = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), eq(cards.execState, 'open'), gt(cards.claimSeq, 0)))
    .orderBy(desc(cards.changeSeq))
    .limit(50).then((rows) => openRows(db, rows));

  // Tomorrow: cards snoozed until then, and cards whose day is tomorrow (§8: their `about`, the calendar's agenda).
  const tomorrow = addDays(today, 1);
  const [tStart, tEnd] = dayRange(tomorrow, head.timezone);
  const ahead = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.headId, headId),
        eq(cards.state, 'open'),
        or(and(gte(cards.snoozedUntil, tStart), lt(cards.snoozedUntil, tEnd)), eq(cards.day, tomorrow)),
      ),
    )
    .orderBy(asc(cards.receivedAt))
    .limit(100).then((rows) => openRows(db, rows));

  // The day opens with its paragraph (lib/brief/fold.ts): the nightly card's lead once it exists, else the same
  // fold now, "so far today". None on a day with nothing open and nothing new. Either way with its parts, each entry
  // with its card's labels (lib/brief/paragraph.ts), for the label filter.
  const presentedDaily = daily ? (await presentCards(db, [daily]))[0]! : null;
  let paragraph: { html: string; so_far: boolean; parts: ParagraphParts; text?: string } | null = null;
  if (presentedDaily && presentedDaily.id === `head:daily:${today}` && currentFold(presentedDaily) && presentedDaily.paragraph) {
    if (presentedDaily.rendered_lead) paragraph = { html: presentedDaily.rendered_lead, so_far: false, parts: presentedDaily.paragraph };
  } else {
    // No card for today yet, or one folded by an older fold or minted before paragraphs had parts: fold now.
    const parts = await annotateParts(db, headId, await dailyParagraphNow(db, headId, head.timezone, today));
    const html = composeParagraph(parts);
    if (html) paragraph = { html, so_far: true, parts };
  }
  // Spoken: the same parts, written for outside the session: `text` in plain words, and `html` the same text escaped, so
  // neither carries a private entry's title or lead.
  if (paragraph && opts.spoken) {
    const text = composeParagraph(paragraph.parts, [], { spoken: true });
    paragraph = { ...paragraph, text, html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  }

  const [oldest] = await db.select({ day: cards.day }).from(cards).where(eq(cards.headId, headId)).orderBy(asc(cards.day)).limit(1);

  const shown = [...decisions, ...taskRows.filter((r) => r.state === 'open'), ...loose, ...late, ...(daily ? [daily] : [])];
  return {
    date: today,
    timezone: head.timezone,
    seq,
    last_visit: { seq: head.lastVisitSeq, at: head.lastVisitAt ? iso(head.lastVisitAt) : null },
    first_day: oldest?.day ?? null,
    daily: presentedDaily,
    daily_paragraph: paragraph,
    tomorrow: { date: tomorrow, cards: await presentCards(db, ahead) },
    decisions: await presentCards(db, decisions),
    tasks,
    threads: folds.map(({ immediate: _i, order: _o, ...f }) => f),
    snoozed,
    late_outcomes: await presentCards(db, late),
    order_updates: orderUpdates,
    lapsed_orders: await presentCards(db, lapsed),
    new: shown.filter((r) => r.changeSeq > head.lastVisitSeq).map((r) => r.id),
  };
}

// --- cards by day ----------------------------------------------------------------

export interface CardQuery {
  date?: string | null;
  from?: string | null;
  to?: string | null;
  since?: string | null;
  until?: string | null;
  state?: string | null;
  after?: string | null;
  limit?: string | null;
}

/**
 * GET /api/me/cards: cards by their day (§8: `about`, else the day of `at` or of received_at in the head's timezone) — one day
 * (`date`) or days `from`–`to` inclusive (the timeline, a week at a time) — or received between `since`/`until`
 * instants, optionally of one `state`, in change_seq order, paginated by change_seq (`after`, `next`). With `from`,
 * `before` is the latest earlier day that has a card (null when there is none), so the timeline skips empty weeks and
 * knows where the head's cards begin.
 */
export async function listCards(db: Db, headId: string, q: CardQuery) {
  const head = await headSettings(db, headId);
  const where: SQL[] = [eq(cards.headId, headId)];
  if (q.date) {
    if (!isDate(q.date)) throw new HttpError(400, 'invalid_request', 'date must be YYYY-MM-DD');
    where.push(eq(cards.day, q.date)); // §8: a card's day, `about`, `at` or received
  }
  let before: string | null | undefined;
  if (q.from || q.to) {
    if (q.date) throw new HttpError(400, 'invalid_request', 'date cannot be combined with from/to');
    if (!q.from || !q.to || !isDate(q.from) || !isDate(q.to) || q.from > q.to) throw new HttpError(400, 'invalid_request', 'from and to must be YYYY-MM-DD, from on or before to');
    where.push(gte(cards.day, q.from), lte(cards.day, q.to));
    const [prev] = await db
      .select({ day: cards.day })
      .from(cards)
      .where(and(eq(cards.headId, headId), lt(cards.day, q.from)))
      .orderBy(desc(cards.day))
      .limit(1);
    before = prev?.day ?? null;
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

  const raw = await db.select().from(cards).where(and(...where)).orderBy(asc(cards.changeSeq)).limit(limit);
  // At rest: opened for this response; a row that fails its integrity check is left out, and the page's cursor still
  // comes from what was read, so paging goes on past it.
  const presented = await presentCards(db, await openRows(db, raw));
  return {
    // One day: in the day's order (§8, by `at`, then by received_at); the page and `next` stay in change_seq order.
    cards: q.date ? presented.sort(byTime) : presented,
    next: raw.length === limit ? raw.at(-1)!.changeSeq : null,
    timezone: head.timezone,
    ...(before !== undefined ? { before } : {}),
  };
}

// --- one card with its thread --------------------------------------------------------

async function rowsById(db: Db, headId: string, ids: string[]): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(cards).where(and(eq(cards.headId, headId), inArray(cards.id, ids))).then((rows) => openRows(db, rows));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * GET /api/me/cards/{id}: the card, the chain it supersedes (oldest first) and the chain that supersedes it,
 * its references resolved (null when this head does not hold one), and every card of its thread, newest last.
 */
export async function cardWithThread(db: Db, headId: string, id: string) {
  const [row] = await db.select().from(cards).where(and(eq(cards.headId, headId), eq(cards.id, id))).then((rows) => openRows(db, rows));
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
      .limit(1).then((rows) => openRows(db, rows));
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    successors.push(next);
    cur = next.id;
  }

  const refs = ((row.producerDoc as { references?: string[] }).references ?? []).slice(0, 100);
  const referenced = await rowsById(db, headId, refs);

  const thread = (row.producerDoc as { thread?: string }).thread;
  // An order and the cards in its thread (A.3) are one conversation across producers: the order first.
  const orderId = row.toProducer !== null ? row.id : isOrderId(thread) ? thread : undefined;
  const threadRows = orderId
    ? [...(await rowsFor(db, headId, [orderId])), ...(await orderThread(db, headId, orderId))]
    : thread
      ? await db
          .select()
          .from(cards)
          .where(and(eq(cards.headId, headId), eq(cards.producer, row.producer), sql`${cards.producerDoc}->>'thread' = ${thread}`))
          .orderBy(asc(cards.receivedAt), asc(cards.changeSeq))
          .limit(200)
          .then((rows) => openRows(db, rows))
      : [];

  const summary = (r: Row) => {
    const c = toCard(r);
    return {
      id: c.id, title: c.title, kind: c.kind, producer: c.producer, state: c.state, received_at: c.received_at,
      ...(c.decision ? { decision: c.decision } : {}),
      ...(c.exec_state ? { exec_state: c.exec_state } : {}),
      ...(r.outcome ? { order_outcome: r.outcome } : {}),
    };
  };
  // The decision log for this card (§4.4, §11.3: every decision, and the card it was made on), oldest first, with the
  // device that recorded it by name.
  const log = await db
    .select({ seq: decisionLog.seq, decision: decisionLog.decision, decidedAt: decisionLog.decidedAt, content: decisionLog.content, delegatedTo: decisionLog.delegatedTo, actor: decisionLog.actor, device: devices.name, platform: devices.platform })
    .from(decisionLog)
    .leftJoin(devices, eq(devices.id, decisionLog.actor))
    .where(and(eq(decisionLog.headId, headId), eq(decisionLog.cardId, row.id)))
    .orderBy(asc(decisionLog.seq))
    // At rest: each row's comment and edited text opened for this response.
    .then(async (rows) => {
      const key = await dataKey(db, headId);
      return rows.map((r) => openLogRow({ ...r, headId }, key));
    });
  const head = await headSettings(db, headId);
  return {
    timezone: head.timezone,
    card: { ...(await presentCards(db, [row]))[0]!, ...(row.toProducer !== null ? { lease: leaseOf(row) } : {}) },
    predecessors: await presentCards(db, predecessors),
    successors: successors.map(summary),
    references: await Promise.all(refs.map(async (ref) => ({ id: ref, card: referenced.has(ref) ? summary(referenced.get(ref)!) : null }))),
    thread: threadRows.map(summary),
    decisions: log.map((l) => ({
      decision: l.decision,
      decided_at: iso(l.decidedAt),
      ...(l.editedProposal !== null ? { edited_proposal: l.editedProposal } : {}),
      ...(l.comment !== null ? { comment: l.comment } : {}),
      ...(l.delegatedTo !== null ? { delegated_to: l.delegatedTo } : {}),
      by: l.device ?? (l.platform ? `a ${l.platform} device` : l.actor),
    })),
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
  const floors = (await loadPolicy(db, headId)).producers;
  return roots.map((root) => {
    const mine = tokens.filter((t) => t.root === root);
    const active = mine.filter((t) => t.revokedAt === null);
    const newest = active.at(-1) ?? mine.at(-1)!;
    const at = lastAt.get(root);
    return {
      root,
      ceiling: newest.urgencyCeiling,
      sensitivity_floor: floors.get(root) ?? null,
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
    timezone: d.timezone,
    timezone_seen_at: d.tzSeenAt ? iso(d.tzSeenAt) : null,
    current: d.id === current,
    daily_notification: { enabled: d.notifyDaily, time: formatTime(d.notifyAtMinutes), subscribed: d.pushEndpoint !== null },
    urgent_notification: { enabled: d.notifyUrgent, subscribed: d.pushEndpoint !== null },
  }));
}

// --- what an assistant receives (RFC 0.9 §4.1, §12) -------------------------------------------------------------------

/** Card fields an assistant never receives for a `private` or `confirm` card: its content, in any form (§4.1). */
const CONTENT = ['summary', 'body', 'lead', 'lead_source', 'rendered_html', 'rendered_lead', 'rendered_actions', 'first_visual', 'comment', 'edited_proposal', 'paragraph', 'spoken_paragraph'] as const;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Json = Record<string, unknown>;
const isCardLike = (v: Json) => typeof v.id === 'string' && typeof v.producer === 'string' && typeof v.kind === 'string';

/**
 * One card (or a paragraph entry) as an assistant may see it. RFC 0.9 §4.1: a head MUST NOT include a `private` or
 * `confirm` card's lead or body "in a notification, an assistant index or any surface outside the owner's signed-in
 * session"; §12: "an assistant connector that holds the owner's credential … cannot approve a confirm card".
 *
 * - private or confirm: its content goes (summary, body, lead, rendered HTML, first visual, option bodies, the owner's
 *   comment and edited proposal); id, kind, producer, title, state, labels, when, source, both sensitivities, the
 *   decision, its times and what replaced it stay. An open confirm decision or task loses `actions`: the assistant cannot
 *   decide it, so it is offered no choice. A paragraph entry keeps its title and loses the lead in its `text`.
 * - a `head:daily:*` card: its body names every entry, private ones too, so the assistant gets the spoken paragraph in
 *   its place (private entries counted, §4.1), and its parts with private entries reduced the same way.
 */
function redactCard(v: Json, policy: SensitivityPolicy): Json {
  const effective =
    (v.effective_sensitivity as Sensitivity | undefined) ??
    effectiveOf({ producer: v.producer as string, labels: (v.labels as string[] | undefined) ?? [], ...(v.sensitivity ? { sensitivity: v.sensitivity as Sensitivity } : {}) }, policy);
  const out: Json = { ...v };
  if (typeof v.id === 'string' && v.id.startsWith('head:daily:')) {
    const spoken = typeof v.spoken_paragraph === 'string' ? v.spoken_paragraph : '';
    for (const k of ['summary', 'lead_source', 'rendered_actions', 'first_visual'] as const) delete out[k];
    out.body = spoken;
    out.lead = spoken;
    out.rendered_lead = escapeHtml(spoken);
    out.rendered_html = spoken ? `<p>${escapeHtml(spoken)}</p>` : '';
    if (out.paragraph) out.paragraph = redactValue(out.paragraph, policy);
    return out;
  }
  if (effective === 'normal') return out;
  out.effective_sensitivity = effective;
  for (const k of CONTENT) delete out[k];
  // A paragraph entry: "<title> — <lead>" becomes the title alone.
  if (typeof v.text === 'string') out.text = typeof v.title === 'string' ? escapeHtml(v.title) : '';
  if (Array.isArray(v.actions)) {
    if (effective === 'confirm' && v.state === 'open') delete out.actions;
    else out.actions = (v.actions as unknown[]).map((a) => (a && typeof a === 'object' ? (({ body: _b, ...rest }) => rest)(a as Json) : a));
  }
  if (Array.isArray(v.options)) out.options = (v.options as Json[]).map(({ body: _b, ...rest }) => rest);
  if ('editable' in v) out.editable = false;
  return out;
}

/** Every card-shaped object in a response, at any depth, as an assistant may see it (redactCard). */
function redactValue(v: unknown, policy: SensitivityPolicy): unknown {
  if (Array.isArray(v)) return v.map((x) => redactValue(x, policy));
  if (!v || typeof v !== 'object') return v;
  const o = v as Json;
  const walked: Json = {};
  for (const [k, x] of Object.entries(o)) walked[k] = redactValue(x, policy);
  // A paragraph entry before the head annotated it carries no producer: it is a card id with labels and text.
  return isCardLike(walked) ? redactCard(walked, policy) : walked;
}

/**
 * A response body for an assistant's scoped token (session platform `mcp`), with every private and confirm card's
 * content removed by the head itself, wherever the card sits: the brief's lists and paragraph parts, a card and its
 * thread, a list of cards, an action's returned card. GET /api/me/cards/{id} also drops the decision log's comment and
 * edited proposal when the card is private. The owner's own session never goes through this.
 */
export async function redactForAssistant<T>(db: Db, headId: string, body: T): Promise<T> {
  const policy = await loadPolicy(db, headId);
  const out = redactValue(body, policy) as T;
  const detail = out as unknown as { card?: Json; decisions?: Json[] };
  if (detail && typeof detail === 'object' && detail.card && Array.isArray(detail.decisions) && detail.card.effective_sensitivity && detail.card.effective_sensitivity !== 'normal') {
    detail.decisions = detail.decisions.map(({ comment: _c, edited_proposal: _e, ...rest }) => rest);
  }
  return out;
}
