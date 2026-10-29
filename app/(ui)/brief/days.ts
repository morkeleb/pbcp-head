// The brief page's data for one selected day, shaped once for the page (use-brief.ts) and the front door's demo
// (lib/demo/replay.ts) alike: the brief column (§8, the generated brief) and the day view's rail (§8, a card's time).
// Pure, for the browser and the server.

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

/** The brief column for a day: its paragraph, its decisions, its artifact and signal threads, the snoozed count. */
export interface BriefColumn {
  date: string;
  /** Today's brief, from GET /api/me/brief; any other day is that day's cards. */
  today: boolean;
  /** The day's paragraph; `parts` when the head kept its entries apart, so the label filter can follow it. */
  paragraph: { html: string; soFar: boolean; parts?: ParagraphParts; /** The label filter's choice, when one is on. */ chosen?: string[] } | null;
  decisions: MeCard[];
  threads: UpdateThread[];
  /** Open decisions snoozed: counted, never listed (§8). */
  snoozed: number;
}

/** How far ahead the day navigation reaches: cards about a later day are shown on it (§8). */
export const AHEAD = 7;

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The Monday-first week around `date`. */
export const weekOf = (date: string): string[] => {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => addDays(date, i - dow));
};

/** "Fri 31 Oct". */
export const shortDay = (date: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).formatToParts(new Date(`${date}T00:00:00Z`));
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
};

/** "Today", "Yesterday", "Tomorrow", else "Fri 31 Oct". */
export const dayName = (date: string, today: string): string =>
  date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : date === addDays(today, 1) ? 'Tomorrow' : shortDay(date);

/** The local day, YYYY-MM-DD, of an instant in the head's timezone. */
export const localDay = (at: string, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

/** Cards sharing producer and thread together, newest last (§8); a card without a thread is its own. Newest thread first. */
export function threads(cards: MeCard[]): UpdateThread[] {
  const groups = new Map<string, MeCard[]>();
  for (const c of [...cards].sort((a, b) => a.change_seq - b.change_seq)) {
    const key = `${c.producer}\u0000${c.thread ?? `\u0001${c.id}`}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()]
    .map((cs) => ({ latest: cs.at(-1)!, earlier: cs.slice(0, -1).map(earlierOf) }))
    .sort((a, b) => b.latest.change_seq - a.latest.change_seq);
}

const earlierOf = ({ id, title, received_at, acknowledged_at, kind }: MeCard): UpdateThread['earlier'][number] => ({ id, title, received_at, kind, ...(acknowledged_at ? { acknowledged_at } : {}) });

export const isUpdate = (c: { kind: string }) => c.kind === 'artifact' || c.kind === 'signal';

/** Today's brief column, from GET /api/me/brief. */
export function todayColumn(b: BriefResponse): BriefColumn {
  return {
    date: b.date,
    today: true,
    paragraph: b.daily_paragraph ? { html: b.daily_paragraph.html, soFar: b.daily_paragraph.so_far, parts: b.daily_paragraph.parts } : null,
    decisions: b.decisions,
    threads: b.threads.map((f) => ({ latest: f.latest, earlier: f.cards.filter((c) => c.id !== f.latest.id) })),
    snoozed: b.snoozed,
  };
}

/**
 * Another day's brief column, from that day's cards (GET /api/me/cards?date=): its own nightly paragraph, its decision
 * cards in whatever state, newest first, and its artifact and signal threads that were delivered to a brief (§9: a
 * `log` card is in the day view only). What the day held, not what is open now: today's column is that.
 */
export function dayColumn(date: string, cards: MeCard[]): BriefColumn {
  // Only a card whose lead is a daily paragraph opens the day; an older fold's lead is a counts line.
  const daily = cards.find((c) => c.id === `head:daily:${date}` && hasParagraph(c));
  const current = cards.filter((c) => c.state !== 'superseded' && c.producer !== 'head');
  return {
    date,
    today: false,
    paragraph: daily?.rendered_lead ? { html: daily.rendered_lead, soFar: false, ...(daily.paragraph ? { parts: daily.paragraph } : {}) } : null,
    decisions: current.filter((c) => c.kind === 'decision').sort((a, b) => b.received_at.localeCompare(a.received_at)),
    threads: threads(current.filter((c) => isUpdate(c) && c.delivery !== 'log')),
    snoozed: 0,
  };
}

/** The day view's cards: those of the day that carry `at`, from every producer, `log` included, in the day's order (§8). */
export const railCards = (cards: MeCard[]): MeCard[] => cards.filter((c) => c.at !== undefined && c.state !== 'superseded').sort(byTime);

/** What the column asks of the person: undecided decisions, and artifacts and signals not acknowledged (the "N new"). */
export function wanting(column: BriefColumn): number {
  const decisions = column.decisions.filter((c) => c.state === 'open').length;
  const updates = column.threads.reduce((n, t) => n + (t.latest.acknowledged_at ? 0 : 1) + t.earlier.filter((e) => !e.acknowledged_at).length, 0);
  return decisions + updates;
}

/**
 * Where each card is presented in the column (§4.5): a decision on its own row, a thread's cards on the thread's row.
 * The day view links its markers here.
 */
export function anchors(column: BriefColumn): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of column.decisions) out.set(c.id, rowId(c.id));
  for (const t of column.threads) for (const id of [t.latest.id, ...t.earlier.map((e) => e.id)]) out.set(id, rowId(t.latest.id));
  return out;
}

/** The element id of a card's row in the brief column. */
export const rowId = (id: string) => `brief-${id}`;

/** The later cards that reference each card (§8: a decided card paired with what came of it), from what is loaded. */
export function referencedBy(cards: Iterable<MeCard>): Map<string, MeCard[]> {
  const out = new Map<string, MeCard[]>();
  for (const c of cards) for (const ref of c.references ?? []) out.set(ref, [...(out.get(ref) ?? []), c]);
  for (const list of out.values()) list.sort((a, b) => a.received_at.localeCompare(b.received_at));
  return out;
}
