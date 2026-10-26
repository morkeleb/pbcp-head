// The nightly `head:daily:YYYY-MM-DD` card (docs/head-skeleton.md: Vercel Cron, 05:30 in the head's
// timezone). The cron calls this every half hour; each head whose local time is past 05:30 and that has no
// card for its local date gets one. A missed run is caught up by the next; a second run mints nothing.
// The card goes through the same submit path as any producer's (A.1: the head owns the `head:` root).

import { and, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cards, heads } from '../../db/schema';
import { now } from '../clock';
import { submitCard } from '../protocol';
import { renderAfterCommit } from '../render';
import { load, toCard } from '../store';
import { addDays, dayRange, localDate, localMinutes } from '../time';
import { foldDaily } from './fold';

export const BRIEF_AT_MINUTES = 5 * 60 + 30;

export async function mintDailyCard(db: Db, headId: string, timezone: string, date: string) {
  const [start, end] = dayRange(addDays(date, -1), timezone);
  const open = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), ne(cards.producer, 'head'), sql`${cards.producerDoc}->>'kind' = 'decision'`))
    .orderBy(desc(cards.receivedAt));
  const yesterday = await db
    .select()
    .from(cards)
    .where(and(eq(cards.headId, headId), ne(cards.producer, 'head'), gte(cards.receivedAt, start), lt(cards.receivedAt, end)));
  const card = foldDaily({ owner: headId, date, emittedAt: now(), openDecisions: open.map(toCard), yesterday: yesterday.map(toCard) });
  const r = await submitCard(db, { headId, root: 'head', ceiling: 'brief' }, JSON.stringify(card), encodeURIComponent(card.id));
  await renderAfterCommit(db, headId, r.card);
  return r;
}

export async function runNightly(db: Db): Promise<Array<{ head: string; id: string; status: number }>> {
  const at = new Date(now());
  const minted: Array<{ head: string; id: string; status: number }> = [];
  for (const head of await db.select().from(heads)) {
    if (localMinutes(at, head.timezone) < BRIEF_AT_MINUTES) continue;
    const date = localDate(at, head.timezone);
    const id = `head:daily:${date}`;
    if (await load(db, head.id, id)) continue;
    const r = await mintDailyCard(db, head.id, head.timezone, date);
    minted.push({ head: head.id, id, status: r.status });
  }
  return minted;
}
