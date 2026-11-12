// The daily "brief is ready" notification, per device (Settings → Devices): on each cron run (every 15 minutes,
// vercel.json), every device with the notification on, a subscription, and a chosen local time that passed since the
// previous run gets one push, unless it already had one for that local date. The time is a quarter hour in the
// device's own timezone (the one it last sent in X-Timezone; the head's effective zone when it never sent one).
//
// The device's `last_notified_on` is claimed before sending, so a run that is repeated, or two that overlap, never send
// twice: a push that then fails is not retried that day (at most once, never twice).

import { and, eq, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cards, cronRuns, devices, heads } from '../../db/schema';
import { now } from '../clock';
import { localDate, localMinutes } from '../time';
import { effectiveTimezone } from '../timezone';
import { composeParagraphs, type ParagraphParts } from '../brief/paragraph';
import { annotateParts } from '../sensitivity';
import { openRows } from '../store';
import { keyring } from '../keyring';
import { sendPush, type PushPayload, type SendResult } from './send';

const RUN = 'daily-notification';
/** With no previous run on record, a run covers this much before it. */
const FIRST_WINDOW_MS = 15 * 60 * 1000;

export const NOTIFY_DEFAULT_MINUTES = 7 * 60;

/** "07:15" for 435; the settings and the API speak in HH:MM. */
export const formatTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** HH:MM on a quarter hour, as minutes after midnight; null when it is not one. */
export function parseQuarterHour(time: unknown): number | null {
  const m = typeof time === 'string' ? /^([01]\d|2[0-3]):(00|15|30|45)$/.exec(time) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Whether the local time `at` (minutes) on the device's today falls in the window (from, to]. */
function passedSince(from: Date, to: Date, tz: string, at: number): boolean {
  const today = localDate(to, tz);
  if (localMinutes(to, tz) < at) return false;
  return localDate(from, tz) < today || localMinutes(from, tz) < at;
}

const PUSH_MAX = 240;

/**
 * The first sentence of a paragraph of plain text, at most PUSH_MAX characters: a longer one (a fold names every card it
 * folds, RFC 0.9 §8) is cut after the last whole item that fits ("; " or ", "), else the last whole word, and ends "…".
 */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(t);
  const s = m ? m[0] : t;
  if (s.length <= PUSH_MAX) return s;
  const head = s.slice(0, PUSH_MAX - 1);
  const item = Math.max(head.lastIndexOf('; '), head.lastIndexOf(', '));
  const cut = item > PUSH_MAX / 2 ? item : head.lastIndexOf(' ');
  return `${head.slice(0, cut > 0 ? cut : head.length).replace(/[\s;,:—-]+$/, '')}…`;
}

/**
 * What the notification says: the daily paragraph's first sentence when today's card exists, else how many decisions wait.
 * A notification is outside the owner's signed-in session (RFC 0.9 §4.1 `private`): the paragraph is written from its
 * parts in the spoken form, so a private or confirm entry is counted ("1 decision: and 1 private decision"), never named.
 * A card folded before its paragraph had parts is not read: an owner's floor raised since may cover a card it names, so
 * the notification counts the decisions instead.
 */
export async function dailyPayload(db: Db, headId: string, date: string): Promise<PushPayload> {
  // At rest: the parts are sealed; the row is opened for this notification only, with one unwrap for the whole payload.
  const ring = keyring(db);
  const [daily] = await openRows(ring, await db.select().from(cards).where(and(eq(cards.headId, headId), eq(cards.id, `head:daily:${date}`))));
  const parts = daily?.renderedParagraph as ParagraphParts | null | undefined;
  const sentence = parts ? firstSentence(composeParagraphs(await annotateParts(ring, headId, parts), [], { spoken: true })[0] ?? '') : '';
  let body = sentence;
  if (!body) {
    const at = new Date(now());
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(cards)
      .where(and(eq(cards.headId, headId), eq(cards.state, 'open'), ne(cards.producer, 'head'), sql`${cards.producerDoc}->>'kind' = 'decision'`, or(isNull(cards.snoozedUntil), lte(cards.snoozedUntil, at))))) as [{ n: number }];
    body = n === 0 ? 'Nothing waiting for you.' : `${n} decision${n === 1 ? '' : 's'} waiting`;
  }
  return { title: 'Brief', body, data: { url: '/brief' }, tag: 'pbcp-daily' };
}

export interface DailyNotified {
  device: string;
  date: string;
  result: SendResult;
}

/** One cron run: the devices whose time came since the last run, each sent its daily notification once. */
export async function runDailyNotifications(db: Db): Promise<DailyNotified[]> {
  const to = new Date(now());
  const [prev] = await db.select().from(cronRuns).where(eq(cronRuns.name, RUN));
  // A clock set back (tests) or a first run: the window is the last quarter hour.
  const from = prev && prev.lastRunAt < to ? prev.lastRunAt : new Date(to.getTime() - FIRST_WINDOW_MS);
  await db.insert(cronRuns).values({ name: RUN, lastRunAt: to }).onConflictDoUpdate({ target: cronRuns.name, set: { lastRunAt: to } });

  const candidates = await db
    .select()
    .from(devices)
    .where(and(isNull(devices.revokedAt), eq(devices.notifyDaily, true), isNotNull(devices.pushEndpoint)));
  const sent: DailyNotified[] = [];
  const zones = new Map<string, string>();
  for (const d of candidates) {
    let tz = d.timezone;
    if (!tz) {
      if (!zones.has(d.headId)) {
        const [head] = await db.select({ tz: heads.timezone }).from(heads).where(eq(heads.id, d.headId));
        zones.set(d.headId, (await effectiveTimezone(db, d.headId, head?.tz ?? null)).timezone);
      }
      tz = zones.get(d.headId)!;
    }
    if (!passedSince(from, to, tz, d.notifyAtMinutes)) continue;
    const date = localDate(to, tz);
    // Claim the date first: of two runs at once, or a run repeated, one sends.
    const claimed = await db
      .update(devices)
      .set({ lastNotifiedOn: date })
      .where(and(eq(devices.id, d.id), or(isNull(devices.lastNotifiedOn), sql`${devices.lastNotifiedOn} < ${date}::date`)))
      .returning({ id: devices.id });
    if (claimed.length === 0) continue;
    sent.push({ device: d.id, date, result: await sendPush(db, d, await dailyPayload(db, d.headId, date)) });
  }
  return sent;
}
