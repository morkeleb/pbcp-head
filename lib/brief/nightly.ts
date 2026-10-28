// The nightly `head:daily:YYYY-MM-DD` card (docs/head-skeleton.md: Vercel Cron, 05:30 in the head's
// effective timezone, lib/timezone.ts). The cron calls this every hour; each head whose local time is 05:30
// or later and that has no card for its local date gets one. The card's id is the date, so a run after the
// owner's zone changed mints nothing for a date that already has its card, and a missed run is caught up by
// the next: a day is neither doubled nor, once its 05:30 is reached in the zone the owner is in, skipped.
// The card goes through the same submit path as any producer's (A.1: the head owns the `head:` root).

import { and, desc, eq, gte, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cards, heads } from '../../db/schema';
import { now } from '../clock';
import { submitCard } from '../protocol';
import { renderAfterCommit, renderBody } from '../render';
import { ownOrigin } from '../render/markdown';
import { load, toCard } from '../store';
import { addDays, dayRange, localDate, localMinutes } from '../time';
import { effectiveTimezone } from '../timezone';
import { dailyLines, foldDaily, paragraphParts } from './fold';
import type { ParagraphParts } from './paragraph';

export const BRIEF_AT_MINUTES = 5 * 60 + 30;

/** The head's page for a card: absolute, on the head's own origin, which the renderer keeps as an in-app link. */
const cardUrl = (id: string) => `${ownOrigin()}/card/${encodeURIComponent(id)}`;

/**
 * What the brief for `date` folds (§8): every open decision, the cards whose day (§8) is the day before, and the
 * decisions the owner made on the day before (by `decided_at` in `timezone`), wherever their cards sit.
 */
export async function gatherDaily(db: Db, headId: string, timezone: string, date: string) {
  const open = await db
    .select()
    .from(cards)
    // Received by now: a head's clock can be set back (tests), and a brief never mentions a card from after it.
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), ne(cards.producer, 'head'), sql`${cards.producerDoc}->>'kind' = 'decision'`, lte(cards.receivedAt, new Date(now()))))
    .orderBy(desc(cards.receivedAt));
  const yesterday = await db
    .select()
    .from(cards)
    // Received by now, as above: a card about yesterday that arrives after the brief is in no brief of it.
    .where(and(eq(cards.headId, headId), ne(cards.producer, 'head'), eq(cards.day, addDays(date, -1)), lte(cards.receivedAt, new Date(now()))));
  const [from, to] = dayRange(addDays(date, -1), timezone);
  const decided = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), ne(cards.producer, 'head'), isNotNull(cards.decision), gte(cards.decidedAt, from), lt(cards.decidedAt, to), lte(cards.decidedAt, new Date(now()))));
  return { openDecisions: open.map(toCard), yesterday: yesterday.map(toCard), decidedYesterday: decided.map(toCard) };
}

/**
 * The daily paragraph for `date` as it stands now, before the nightly card exists ("so far today"): the same fold, in
 * parts, each entry rendered to safe inline HTML (lib/brief/paragraph.ts composes them).
 */
export async function dailyParagraphNow(db: Db, headId: string, timezone: string, date: string): Promise<ParagraphParts> {
  return renderParts(db, paragraphParts(dailyLines({ ...(await gatherDaily(db, headId, timezone, date)), at: now() }), cardUrl));
}

/** Each entry's markdown rendered inline by the same pipeline and sanitiser as bodies. */
export async function renderParts(db: Db, parts: ParagraphParts): Promise<ParagraphParts> {
  const inline = async (md: string) => (await renderBody(db, md)).html.trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1');
  const each = (es: ParagraphParts['decisions'] | undefined) => Promise.all((es ?? []).map(async (e) => ({ ...e, text: await inline(e.text) })));
  return { decisions: await each(parts.decisions), snoozed: parts.snoozed, decided: await each(parts.decided), mattered: await each(parts.mattered), rest: parts.rest ?? [] };
}

/** Mints `head:daily:<date>`; a quiet day's says "Nothing waiting for you." */
export async function mintDailyCard(db: Db, headId: string, timezone: string, date: string) {
  const emittedAt = now();
  const gathered = await gatherDaily(db, headId, timezone, date);
  const card = foldDaily({ owner: headId, date, emittedAt, ...gathered, cardUrl });
  const r = await submitCard(db, { headId, root: 'head', ceiling: 'brief' }, JSON.stringify(card), encodeURIComponent(card.id));
  await renderAfterCommit(db, headId, r.card);
  // The paragraph in parts, beside the card's own rendering: head-owned display state, never synced, so a view can
  // show only the entries of the labels the owner filters by.
  const parts = await renderParts(db, paragraphParts(dailyLines({ ...gathered, at: emittedAt }), cardUrl));
  await db.update(cards).set({ renderedParagraph: parts }).where(and(eq(cards.headId, headId), eq(cards.id, card.id)));
  return r;
}

export async function runNightly(db: Db): Promise<Array<{ head: string; id: string; status: number }>> {
  const at = new Date(now());
  const minted: Array<{ head: string; id: string; status: number }> = [];
  for (const head of await db.select().from(heads)) {
    const { timezone } = await effectiveTimezone(db, head.id, head.timezone);
    if (localMinutes(at, timezone) < BRIEF_AT_MINUTES) continue;
    const date = localDate(at, timezone);
    const id = `head:daily:${date}`;
    if (await load(db, head.id, id)) continue;
    const r = await mintDailyCard(db, head.id, timezone, date);
    if (r) minted.push({ head: head.id, id, status: r.status });
  }
  return minted;
}
