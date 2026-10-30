// A brief's days, shaped once for both layouts (the timeline and the broadsheet): the day's paragraph, its decisions, and
// its updates (artifacts) and signals as threads. Pure, for the browser (use-brief.ts) and the server alike (the front
// door's demo brief, lib/demo/replay.ts).

import type { MeCard } from '../components';
import { hasParagraph } from '../../../lib/brief/fold-version';
import type { ParagraphParts } from '../../../lib/brief/paragraph';
import { byTime } from '../../../lib/time';
import type { UpdateThread } from './UpdateRow';

export interface BriefResponse {
  date: string;
  timezone: string;
  seq: number;
  last_visit: { seq: number; at: string | null };
  first_day: string | null;
  daily: MeCard | null;
  daily_paragraph: { html: string; so_far: boolean; parts: ParagraphParts } | null;
  tomorrow: { date: string; cards: MeCard[] };
  decisions: MeCard[];
  threads: Array<{ producer: string; thread: string | null; count: number; latest: MeCard; cards: UpdateThread['earlier'] }>;
  snoozed: number;
  late_outcomes: MeCard[];
  lapsed_orders: MeCard[];
  new: string[];
}

export interface Day {
  date: string;
  kind: 'past' | 'today' | 'tomorrow' | 'ahead';
  /** The day's paragraph; `parts` when the head kept its entries apart, so the label filter can follow it. */
  paragraph: { html: string; soFar: boolean; parts?: ParagraphParts; /** The label filter's choice, when one is on. */ chosen?: string[] } | null;
  decisions: MeCard[];
  updates: UpdateThread[];
  signals: UpdateThread[];
  /** An earlier day the person jumped to on which nothing arrived: shown, with a line saying so. */
  nothing?: boolean;
  /** The day's cards with `at`, for its schedule (RFC 0.8 §8); undefined until they are loaded. */
  rail?: MeCard[];
  /** Every card of the day, when loaded: the schedule finds a timed card's thread in them. */
  cards?: MeCard[];
}

/** Earlier days are fetched this many at a time. */
export const WEEK = 7;

/** How far ahead the timeline reaches: the days after tomorrow with cards about them (a calendar sends a week or so). */
export const AHEAD = 14;

/**
 * A day after tomorrow: what is set for it (§8: a card about a later day appears on that day). Its artifacts and signals
 * as threads, and its schedule; its open decisions are under today, marked with their day.
 */
export function aheadOf(date: string, cards: MeCard[]): Day {
  return {
    date,
    kind: 'ahead',
    paragraph: null,
    decisions: [],
    ...split(threads(cards.filter((c) => isUpdate(c) && c.producer !== 'head' && c.state === 'open' && c.delivery !== 'log' && rowed(c)))),
    rail: railCards(cards),
    cards,
    ...(cards.length === 0 ? { nothing: true } : {}),
  };
}

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Cards sharing producer and thread together, newest last (§8); a card without a thread is its own. */
export function threads(cards: MeCard[]): UpdateThread[] {
  const groups = new Map<string, MeCard[]>();
  for (const c of [...cards].sort((a, b) => a.change_seq - b.change_seq)) {
    const key = `${c.producer}\u0000${c.thread ?? `\u0001${c.id}`}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()]
    .map((cs) => ({ latest: cs.at(-1)!, earlier: cs.slice(0, -1).map(({ id, title, received_at, acknowledged_at }) => ({ id, title, received_at, ...(acknowledged_at ? { acknowledged_at } : {}) })) }))
    .sort((a, b) => b.latest.change_seq - a.latest.change_seq);
}

/** "Fri 31 Oct". */
export const shortDay = (date: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).formatToParts(new Date(`${date}T00:00:00Z`));
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
};

/**
 * Where a card is shown in its day: a card with `at` is on the schedule and nowhere else (§8: a card's time), unless it
 * is an open decision, whose card with its controls stays among the decisions and has a marker on the schedule (§4.5).
 * A card without `at` is a decision, an update or a signal row as before.
 */
export const timed = (c: Pick<MeCard, 'at'>): boolean => c.at !== undefined;
export const rowed = (c: MeCard): boolean => !timed(c) || (c.kind === 'decision' && c.state === 'open');

/**
 * The schedule's cards: the day's cards that carry `at`, from every producer, `log` included, in the day's order (§8).
 * Not a superseded one (a cancelled occurrence: the signal that cancelled it is there), nor one snoozed for now.
 */
export const railCards = (cards: MeCard[]): MeCard[] =>
  cards.filter((c) => timed(c) && c.state !== 'superseded' && !(c.snoozed_until && Date.parse(c.snoozed_until) > Date.now())).sort(byTime);

/** The element id of a card's row on the brief, which the rail's markers link to. */
export const rowId = (id: string) => `brief-${id}`;

/** Where each card of a day is presented (§4.5): a decision on its own row, a thread's cards on the thread's row. */
export function anchors(day: Day): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of day.decisions) out.set(c.id, rowId(c.id));
  for (const t of [...day.updates, ...day.signals]) for (const id of [t.latest.id, ...t.earlier.map((e) => e.id)]) out.set(id, rowId(t.latest.id));
  return out;
}

/** The later cards that reference each card (§8: a decided card paired with what came of it), from what is loaded. */
export function referencedBy(cards: Iterable<MeCard>): Map<string, MeCard[]> {
  const out = new Map<string, MeCard[]>();
  for (const c of cards) for (const ref of c.references ?? []) out.set(ref, [...(out.get(ref) ?? []), c]);
  for (const list of out.values()) list.sort((a, b) => a.received_at.localeCompare(b.received_at));
  return out;
}

/** The local day, YYYY-MM-DD, of an instant in the head's timezone. */
export const localDay = (at: string, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

export const isUpdate = (c: MeCard) => c.kind === 'artifact' || c.kind === 'signal';
export const split = (ts: UpdateThread[]) => ({ updates: ts.filter((t) => t.latest.kind === 'artifact'), signals: ts.filter((t) => t.latest.kind === 'signal') });

/**
 * Today, from the brief. With today's cards (`cards`, every one of them), its threads keep only their cards without
 * `at`, which are on the schedule instead; a thread left with none is not a row.
 */
export function todayOf(b: BriefResponse, cards?: MeCard[]): Day {
  const byId = new Map((cards ?? []).map((c) => [c.id, c]));
  const onSchedule = (id: string) => !!byId.get(id)?.at;
  const ts: UpdateThread[] = b.threads.flatMap((f) => {
    const kept = f.cards.filter((c) => !onSchedule(c.id));
    const latest = !onSchedule(f.latest.id) ? f.latest : byId.get(kept.at(-1)?.id ?? '');
    return latest ? [{ latest, earlier: kept.filter((c) => c.id !== latest.id) }] : [];
  });
  return {
    date: b.date,
    kind: 'today',
    paragraph: b.daily_paragraph ? { html: b.daily_paragraph.html, soFar: b.daily_paragraph.so_far, parts: b.daily_paragraph.parts } : null,
    decisions: b.decisions,
    ...split(ts),
  };
}

/** An earlier day: what was decided that day (open decisions are under today), its updates, and its own paragraph. */
export function pastOf(date: string, cards: MeCard[]): Day {
  // Only a card whose lead is a daily paragraph opens the day; an older fold's lead is a counts line.
  const daily = cards.find((c) => c.id === `head:daily:${date}` && hasParagraph(c));
  return {
    date,
    kind: 'past',
    paragraph: daily?.rendered_lead ? { html: daily.rendered_lead, soFar: false, ...(daily.paragraph ? { parts: daily.paragraph } : {}) } : null,
    decisions: cards.filter((c) => c.kind === 'decision' && c.state !== 'open' && rowed(c)),
    ...split(threads(cards.filter((c) => isUpdate(c) && c.producer !== 'head' && rowed(c)))),
    ...(cards.length === 0 ? { nothing: true } : {}),
    rail: railCards(cards),
    cards,
  };
}

export function tomorrowOf(b: BriefResponse): Day {
  return { date: b.tomorrow.date, kind: 'tomorrow', paragraph: null, decisions: b.tomorrow.cards.filter((c) => c.kind === 'decision' && rowed(c)), ...split(threads(b.tomorrow.cards.filter((c) => isUpdate(c) && rowed(c)))) };
}

