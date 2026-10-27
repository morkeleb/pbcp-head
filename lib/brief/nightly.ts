// The nightly `head:daily:YYYY-MM-DD` card (docs/head-skeleton.md: Vercel Cron, 05:30 in the head's
// effective timezone, lib/timezone.ts). The cron calls this every hour; each head whose local time is 05:30
// or later and that has no card for its local date gets one. The card's id is the date, so a run after the
// owner's zone changed mints nothing for a date that already has its card, and a missed run is caught up by
// the next: a day is neither doubled nor, once its 05:30 is reached in the zone the owner is in, skipped.
// The card goes through the same submit path as any producer's (A.1: the head owns the `head:` root).

import { and, desc, eq, gte, lt, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cards, heads } from '../../db/schema';
import { now } from '../clock';
import { submitCard } from '../protocol';
import { renderAfterCommit } from '../render';
import { ownOrigin } from '../render/markdown';
import { load, toCard } from '../store';
import { addDays, dayRange, localDate, localMinutes } from '../time';
import { effectiveTimezone } from '../timezone';
import { dailyLines, dailyParagraph, foldDaily } from './fold';

export const BRIEF_AT_MINUTES = 5 * 60 + 30;

/** The head's page for a card: absolute, on the head's own origin, which the renderer keeps as an in-app link. */
const cardUrl = (id: string) => `${ownOrigin()}/card/${encodeURIComponent(id)}`;

/** What the brief for `date` folds (§8): every open decision, and the previous local day's cards. */
export async function gatherDaily(db: Db, headId: string, timezone: string, date: string) {
  const [start, end] = dayRange(addDays(date, -1), timezone);
  const open = await db
    .select()
    .from(cards)
    // Received by now: a head's clock can be set back (tests), and a brief never mentions a card from after it.
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), ne(cards.producer, 'head'), sql`${cards.producerDoc}->>'kind' = 'decision'`, lte(cards.receivedAt, new Date(now()))))
    .orderBy(desc(cards.receivedAt));
  const yesterday = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), ne(cards.producer, 'head'), gte(cards.receivedAt, start), lt(cards.receivedAt, end)));
  return { openDecisions: open.map(toCard), yesterday: yesterday.map(toCard) };
}

/**
 * The daily paragraph for `date` as it stands now, before the nightly card exists ("so far today"): the same fold,
 * as markdown. Empty when nothing is open and nothing arrived the day before.
 */
export async function dailyParagraphNow(db: Db, headId: string, timezone: string, date: string): Promise<string> {
  const { openDecisions, yesterday } = await gatherDaily(db, headId, timezone, date);
  return dailyParagraph(dailyLines({ openDecisions, yesterday }), cardUrl);
}

/** Mints `head:daily:<date>`; null on a day with nothing open and nothing new, which gets no card. */
export async function mintDailyCard(db: Db, headId: string, timezone: string, date: string) {
  const card = foldDaily({ owner: headId, date, emittedAt: now(), ...(await gatherDaily(db, headId, timezone, date)), cardUrl });
  if (!card) return null;
  const r = await submitCard(db, { headId, root: 'head', ceiling: 'brief' }, JSON.stringify(card), encodeURIComponent(card.id));
  await renderAfterCommit(db, headId, r.card);
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
