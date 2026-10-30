'use client';

// The brief's data for both layouts: today (GET /api/me/brief), earlier days loaded a week at a time as the person
// scrolls up (GET /api/me/cards?from=&to=), as far back as the head has cards (§8: every card stays reachable), and
// tomorrow (from the brief), and the days after it that have cards, up to two weeks ahead. Each day's schedule (its
// cards with `at`, RFC 0.8 §8) comes from its cards: an earlier day's as loaded, today's and the days ahead from
// GET /api/me/cards?from=&to=, since the brief leaves `log` cards out. Days are shaped once here, the same for the timeline and
// the broadsheet: the day's paragraph, its decisions, its updates (artifacts) and signals as threads.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useFresh } from '../client';
import type { MeCard } from '../components';

import { addDays, aheadOf, AHEAD, localDay, pastOf, railCards, referencedBy, todayOf, tomorrowOf, WEEK, type BriefResponse, type Day } from './days';

export { addDays, type BriefResponse, type Day };

/** How often an open brief asks whether it changed, and the least time between two asks (focus and visibility fire together). */
const LIVE_EVERY_MS = 60_000;
const LIVE_MIN_GAP_MS = 15_000;

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
  // Today's cards and those of the days ahead, every one of them, by day: for their schedules, and for the days after
  // tomorrow, which the brief does not carry. A day jumped to that has none is kept, empty, so it can be shown.
  const [near, setNear] = useState<Map<string, MeCard[]>>(new Map());
  const loadNear = useCallback(async (today: string, tz: string, network = false) => {
    const cards: MeCard[] = [];
    for (let after: number | null = 0; after !== null; ) {
      const r: { status: number; body: { cards: MeCard[]; next: number | null } } = await api(`/api/me/cards?from=${today}&to=${addDays(today, AHEAD)}&limit=200${after ? `&after=${after}` : ''}`, { network }).catch(() => ({ status: 0, body: { cards: [], next: null } }));
      if (r.status !== 200) return;
      cards.push(...r.body.cards);
      after = r.body.next;
    }
    setNear((m) => {
      const next = new Map<string, MeCard[]>();
      for (const [day, list] of m) if (list.length === 0) next.set(day, []); // days jumped to stay
      for (const c of cards) {
        const day = c.day ?? localDay(c.received_at, tz);
        next.set(day, [...(next.get(day) ?? []), c]);
      }
      return next;
    });
  }, []);
  // Decisions decided here stay in today's list, in their place and their new state, when the brief loads again (it
  // lists only open ones): what the person is looking at does not move. The next visit no longer lists them.
  const settled = useRef(new Map<string, MeCard>());
  const load = useCallback(async (network = false, quiet = false) => {
    const r = await api<BriefResponse>('/api/me/brief', { network });
    // A refresh that fails leaves the brief on screen as it was; only a first load reports.
    if (r.status !== 200 && quiet) return;
    if (r.status !== 200) return setError(r.status === 0 || r.status === 503 ? 'You’re offline, and this device has no copy of the brief yet.' : `Could not load the brief (${r.status}).`);
    setBrief((prev) => keepPlaces(prev, r.body, settled.current));
    setCachedAt(r.cachedAt ?? null);
    seq.current ??= r.body.seq; // the first view sets what "seen" means when the owner leaves
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => void (brief?.date && loadNear(brief.date, brief.timezone)), [brief?.date, brief?.timezone, loadNear]);
  const fresh = useCallback((b: BriefResponse) => {
    setBrief((prev) => keepPlaces(prev, b, settled.current));
    setCachedAt(null);
  }, []);
  const stale = useCallback(() => void load(true), [load]);
  useFresh('/api/me/brief', fresh, stale);

  // Live: whatever the device's notification settings, the brief looks for changes when the app comes back to the
  // foreground and once a minute while it is on screen, and at once when a push arrives (the service worker says so;
  // only a device with notifications on gets pushes). It asks the head's change counter and date (GET /api/me/seq), and
  // loads the brief again only when one has moved: what is on screen (scroll, open cards, the label filter) stays.
  const current = useRef<BriefResponse | null>(null);
  current.current = brief;
  useEffect(() => {
    let last = 0;
    let busy = false;
    const check = async (now = false) => {
      if (document.visibilityState !== 'visible' || busy || !current.current) return;
      if (!now && Date.now() - last < LIVE_MIN_GAP_MS) return;
      last = Date.now();
      busy = true;
      try {
        const r = await api<{ seq: number; date: string }>('/api/me/seq', { network: true });
        const b = current.current;
        if (r.status === 200 && b && (r.body.seq !== b.seq || r.body.date !== b.date)) {
          await load(true, true);
          await loadNear(r.body.date, b.timezone, true);
        }
      } catch {
        // offline, or signed out: the next check tries again
      } finally {
        busy = false;
      }
    };
    const onVisible = () => void check();
    const onMessage = (e: MessageEvent) => void ((e.data as { type?: string } | null)?.type === 'pbcp-push' && check(true));
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    const timer = setInterval(() => void check(), LIVE_EVERY_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      clearInterval(timer);
    };
  }, [load, loadNear]);

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
    if (c.kind === 'decision') {
      if (c.state === 'decided') settled.current.set(c.id, c);
      else settled.current.delete(c.id);
    }
    setBrief((b) => {
      if (!b) return b;
      const hidden = !!c.snoozed_until && c.snoozed_until > new Date().toISOString();
      const decisions = hidden ? b.decisions.filter((d) => d.id !== c.id) : b.decisions.map((d) => (d.id === c.id ? c : d));
      const intoTomorrow = hidden && c.snoozed_until!.slice(0, 10) <= b.tomorrow.date && !b.tomorrow.cards.some((t) => t.id === c.id);
      const tomorrowCards = intoTomorrow ? [...b.tomorrow.cards, c] : b.tomorrow.cards.map((t) => (t.id === c.id ? c : t));
      // The head's counter moved by this change alone: the brief is still current, and the live check need not reload it.
      const seq = c.change_seq === b.seq + 1 ? c.change_seq : b.seq;
      return { ...b, seq, decisions, tomorrow: { ...b.tomorrow, cards: tomorrowCards } };
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
  const withRail = (d: Day): Day => (near.has(d.date) ? { ...d, rail: railCards(near.get(d.date)!) } : d);
  const later = brief ? [...near.entries()].filter(([date]) => date > addDays(brief.date, 1)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, cards]) => aheadOf(date, cards)) : [];
  const days: Day[] = brief ? [...pastDays, withRail(todayOf(brief)), withRail(tomorrowOf(brief)), ...later] : [];
  // §8 pairing: the later cards that reference a card, from everything loaded.
  const references = referencedBy([...past.values(), ...near.values()].flat());
  /** A day after tomorrow the person went to: shown even with nothing set for it. */
  const showAhead = useCallback((date: string) => setNear((m) => (m.has(date) ? m : new Map(m).set(date, []))), []);
  return { brief, days, references, cachedAt, error, loadEarlier, showAhead, loadedFrom: reach.from, atStart: reach.before === null, loadedBack: past, change };
}

/**
 * The brief loaded again, with today's decisions where they were: those still listed keep their place, the ones decided
 * here stay in it (in their new state), and new ones come in at the top, newest first, as the list is ordered.
 */
function keepPlaces(prev: BriefResponse | null, next: BriefResponse, settled: Map<string, MeCard>): BriefResponse {
  if (!prev || prev.date !== next.date) return next;
  const now = new Map(next.decisions.map((c) => [c.id, c]));
  const kept = prev.decisions.flatMap((c) => (now.has(c.id) ? [now.get(c.id)!] : settled.has(c.id) ? [settled.get(c.id)!] : []));
  const shown = new Set(kept.map((c) => c.id));
  return { ...next, decisions: [...next.decisions.filter((c) => !shown.has(c.id)), ...kept] };
}
