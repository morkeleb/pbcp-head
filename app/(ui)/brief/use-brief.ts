'use client';

// The brief's data for both layouts: today (GET /api/me/brief), earlier days loaded a week at a time as the person
// scrolls up (GET /api/me/cards?from=&to=), as far back as the head has cards (§8: every card stays reachable), and
// tomorrow (from the brief). Days are shaped once here, the same for the timeline and
// the broadsheet: the day's paragraph, its decisions, its updates (artifacts) and signals as threads.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useFresh } from '../client';
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
function threads(cards: MeCard[]): UpdateThread[] {
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

const isUpdate = (c: MeCard) => c.kind === 'artifact' || c.kind === 'signal';
const split = (ts: UpdateThread[]) => ({ updates: ts.filter((t) => t.latest.kind === 'artifact'), signals: ts.filter((t) => t.latest.kind === 'signal') });

function todayOf(b: BriefResponse): Day {
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
function pastOf(date: string, cards: MeCard[]): Day {
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

function tomorrowOf(b: BriefResponse): Day {
  return { date: b.tomorrow.date, kind: 'tomorrow', paragraph: null, decisions: b.tomorrow.cards.filter((c) => c.kind === 'decision'), ...split(threads(b.tomorrow.cards.filter(isUpdate))) };
}

export function useBrief() {
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [past, setPast] = useState<Map<string, MeCard[]>>(new Map());
  // Earlier days are loaded without gaps from today back to `from`; `before` is the latest day before that with a
  // card (null: the head has none earlier, the timeline has reached its start).
  const [reach, setReach] = useState<{ from: string | null; before: string | null | undefined }>({ from: null, before: undefined });
  const reachRef = useRef(reach);
  reachRef.current = reach;
  const loading = useRef<Promise<boolean> | null>(null);
  const seq = useRef<number | null>(null);

  const load = useCallback(async (network = false) => {
    const r = await api<BriefResponse>('/api/me/brief', { network });
    if (r.status !== 200) return setError(r.status === 0 || r.status === 503 ? 'You’re offline, and this device has no copy of the brief yet.' : `Could not load the brief (${r.status}).`);
    setBrief(r.body);
    setCachedAt(r.cachedAt ?? null);
    seq.current ??= r.body.seq; // the first view sets what "seen" means when the owner leaves
  }, []);
  useEffect(() => void load(), [load]);
  const fresh = useCallback((b: BriefResponse) => {
    setBrief(b);
    setCachedAt(null);
  }, []);
  const stale = useCallback(() => void load(true), [load]);
  useFresh('/api/me/brief', fresh, stale);

  // Leaving the brief advances the global last-visit cursor to what was on screen (mobile PRD: on close).
  useEffect(() => {
    let sent = false;
    const leave = () => {
      if (sent || seq.current === null) return;
      sent = true;
      void api('/api/me/visit', { method: 'POST', body: { seq: seq.current }, keepalive: true }).catch(() => undefined);
    };
    const hidden = () => document.visibilityState === 'hidden' && leave();
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      leave();
    };
  }, []);

  /**
   * Loads earlier days: with `date`, every day from it up to those already loaded (a day jumped to is shown even if
   * nothing came that day); without, the next week back that has cards. Resolves when they are in; false when nothing
   * was loaded (at the start, a scroll's load already running, or the request failed).
   */
  const loadEarlier = useCallback(
    async (date?: string): Promise<boolean> => {
      const today = brief?.date;
      const tz = brief?.timezone;
      if (!today || !tz) return false;
      // One load at a time: a scroll's load already running is the same load again; a jump waits for it, then goes.
      if (loading.current) {
        if (!date) return false;
        await loading.current;
      }
      const { from: loadedFrom, before } = reachRef.current;
      const to = addDays(loadedFrom ?? today, -1);
      // Scrolling: the week ending at the latest day with cards (yesterday on the first load). Jumping: back to `date`.
      if (date && date > to) {
        // Already loaded: a day with nothing on it is not on the timeline until the person asks for it.
        setPast((p) => (date >= today || p.has(date) ? p : new Map(p).set(date, [])));
        return true;
      }
      const end = date ? to : before === undefined ? to : before;
      if (end === null) return false;
      const from = date ?? addDays(end, -(WEEK - 1));
      const load = (async () => {
        const cards: MeCard[] = [];
        let earlier: string | null = null;
        for (let after: number | null = 0; after !== null; ) {
          const r: { status: number; body: { cards: MeCard[]; next: number | null; before?: string | null } } = await api(
            `/api/me/cards?from=${from}&to=${to}&limit=200${after ? `&after=${after}` : ''}`,
          );
          if (r.status !== 200) return false;
          cards.push(...r.body.cards);
          earlier = r.body.before ?? null;
          after = r.body.next;
        }
        setPast((p) => {
          const next = new Map(p);
          for (const c of cards) {
            const day = c.day ?? localDay(c.received_at, tz); // §8: the head's day for the card
            next.set(day, [...(next.get(day) ?? []), c]);
          }
          if (date && !next.has(date)) next.set(date, []); // a day jumped to is shown even when nothing came that day
          return next;
        });
        const next = { from, before: earlier };
        reachRef.current = next; // the next load starts from here even before React re-renders
        setReach(next);
        return true;
      })();
      loading.current = load;
      try {
        return await load;
      } finally {
        loading.current = null;
      }
    },
    [brief?.date, brief?.timezone],
  );

  /** A card changed on screen (decided, seen, snoozed, or rolled back): the same card everywhere it is shown. */
  const change = useCallback((c: MeCard) => {
    setBrief((b) => {
      if (!b) return b;
      const hidden = !!c.snoozed_until && c.snoozed_until > new Date().toISOString();
      const decisions = hidden ? b.decisions.filter((d) => d.id !== c.id) : b.decisions.map((d) => (d.id === c.id ? c : d));
      const intoTomorrow = hidden && c.snoozed_until!.slice(0, 10) <= b.tomorrow.date && !b.tomorrow.cards.some((t) => t.id === c.id);
      const tomorrowCards = intoTomorrow ? [...b.tomorrow.cards, c] : b.tomorrow.cards.map((t) => (t.id === c.id ? c : t));
      return { ...b, decisions, tomorrow: { ...b.tomorrow, cards: tomorrowCards } };
    });
    setPast((p) => {
      let touched = false;
      const next = new Map(p);
      for (const [date, cards] of p) {
        if (cards.some((x) => x.id === c.id)) {
          next.set(date, cards.map((x) => (x.id === c.id ? c : x)));
          touched = true;
        }
      }
      return touched ? next : p;
    });
  }, []);

  const pastDays = [...past.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, cards]) => pastOf(date, cards));
  const days: Day[] = brief ? [...pastDays, todayOf(brief), tomorrowOf(brief)] : [];
  return { brief, days, cachedAt, error, loadEarlier, loadedFrom: reach.from, atStart: reach.before === null, loadedBack: past, change };
}
