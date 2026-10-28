// A brief's days, shaped once for both layouts (the timeline and the broadsheet): the day's paragraph, its decisions, and
// its updates (artifacts) and signals as threads. Pure, for the browser (use-brief.ts) and the server alike (the front
// door's demo brief, lib/demo/replay.ts).

import type { MeCard } from '../components';
import { hasParagraph } from '../../../lib/brief/fold-version';
import type { ParagraphParts } from '../../../lib/brief/paragraph';
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
  kind: 'past' | 'today' | 'tomorrow';
  /** The day's paragraph; `parts` when the head kept its entries apart, so the label filter can follow it. */
  paragraph: { html: string; soFar: boolean; parts?: ParagraphParts; /** The label filter's choice, when one is on. */ chosen?: string[] } | null;
  decisions: MeCard[];
  updates: UpdateThread[];
  signals: UpdateThread[];
  /** An earlier day the person jumped to on which nothing arrived: shown, with a line saying so. */
  nothing?: boolean;
}

/** Earlier days are fetched this many at a time. */
export const WEEK = 7;

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

/** The local day, YYYY-MM-DD, of an instant in the head's timezone. */
export const localDay = (at: string, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

export const isUpdate = (c: MeCard) => c.kind === 'artifact' || c.kind === 'signal';
export const split = (ts: UpdateThread[]) => ({ updates: ts.filter((t) => t.latest.kind === 'artifact'), signals: ts.filter((t) => t.latest.kind === 'signal') });

export function todayOf(b: BriefResponse): Day {
  const ts: UpdateThread[] = b.threads.map((f) => ({ latest: f.latest, earlier: f.cards.filter((c) => c.id !== f.latest.id) }));
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
    decisions: cards.filter((c) => c.kind === 'decision' && c.state !== 'open'),
    ...split(threads(cards.filter((c) => isUpdate(c) && c.producer !== 'head'))),
    ...(cards.length === 0 ? { nothing: true } : {}),
  };
}

export function tomorrowOf(b: BriefResponse): Day {
  return { date: b.tomorrow.date, kind: 'tomorrow', paragraph: null, decisions: b.tomorrow.cards.filter((c) => c.kind === 'decision'), ...split(threads(b.tomorrow.cards.filter(isUpdate))) };
}

