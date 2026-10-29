'use client';

// The brief page's data: today's brief (GET /api/me/brief) and the selected day's cards (GET /api/me/cards?date=, every
// page), from which days.ts shapes the brief column and the day view's rail. Today's column is the live brief; any
// other day's is that day's cards. Cards the person decided or acknowledged here stay where they were, showing their
// new state, when the brief is loaded again (§4.5: the row confirms in place); the next visit no longer lists them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useFresh } from '../client';
import type { MeCard } from '../components';
import { dayColumn, isUpdate, railCards, referencedBy, threads, todayColumn, type BriefColumn, type BriefResponse } from './days';

export { type BriefResponse };

/** How often an open brief asks whether it changed, and the least time between two asks (focus and visibility fire together). */
const LIVE_EVERY_MS = 60_000;
const LIVE_MIN_GAP_MS = 15_000;

export function useBrief() {
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [days, setDays] = useState<Map<string, MeCard[]>>(new Map());
  // Cards changed on this page (decided, acknowledged): kept in place, in their new state, through a reload.
  const [settled, setSettled] = useState<Map<string, MeCard>>(new Map());
  const seq = useRef<number | null>(null);
  const today = brief?.date ?? null;
  const date = selected ?? today;

  const load = useCallback(async (network = false, quiet = false) => {
    const r = await api<BriefResponse>('/api/me/brief', { network });
    // A refresh that fails leaves the brief on screen as it was; only a first load reports.
    if (r.status !== 200 && quiet) return;
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

  /** Every card of a day, all pages, in the day's order (the head sorts one day's page by §8). */
  const loadDay = useCallback(async (day: string, network = false) => {
    const cards: MeCard[] = [];
    for (let after: number | null = 0; after !== null; ) {
      const r: { status: number; body: { cards: MeCard[]; next: number | null } } = await api(`/api/me/cards?date=${day}&limit=200${after ? `&after=${after}` : ''}`, { network });
      if (r.status !== 200) return;
      cards.push(...r.body.cards);
      after = r.body.next;
    }
    setDays((m) => new Map(m).set(day, cards));
  }, []);
  useEffect(() => {
    if (date && !days.has(date)) void loadDay(date);
  }, [date, days, loadDay]);

  // Live: whatever the device's notification settings, the page looks for changes when the app comes back to the
  // foreground and once a minute while it is on screen, and at once when a push arrives (the service worker says so;
  // only a device with notifications on gets pushes). It asks the head's change counter and date (GET /api/me/seq), and
  // loads the brief and the day on screen again only when one has moved.
  const current = useRef<{ brief: BriefResponse | null; date: string | null }>({ brief: null, date: null });
  current.current = { brief, date };
  useEffect(() => {
    let last = 0;
    let busy = false;
    const check = async (now = false) => {
      const { brief: b, date: d } = current.current;
      if (document.visibilityState !== 'visible' || busy || !b) return;
      if (!now && Date.now() - last < LIVE_MIN_GAP_MS) return;
      last = Date.now();
      busy = true;
      try {
        const r = await api<{ seq: number; date: string }>('/api/me/seq', { network: true });
        if (r.status === 200 && (r.body.seq !== b.seq || r.body.date !== b.date)) {
          setDays(new Map()); // every day loads afresh when it is shown again
          await Promise.all([load(true, true), d ? loadDay(d, true) : undefined]);
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
  }, [load, loadDay]);

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

  /** A card changed on screen (decided, seen, snoozed, acknowledged, or rolled back): the same card everywhere it is shown. */
  const change = useCallback((c: MeCard) => {
    const hidden = !!c.snoozed_until && c.snoozed_until > new Date().toISOString();
    setBrief((b) => {
      if (!b) return b;
      const was = b.decisions.some((d) => d.id === c.id);
      const decisions = hidden ? b.decisions.filter((d) => d.id !== c.id) : b.decisions.map((d) => (d.id === c.id ? c : d));
      // A decision snoozed here leaves the list and joins the count (§8).
      return { ...b, decisions, snoozed: b.snoozed + (hidden && was && c.kind === 'decision' ? 1 : 0), threads: b.threads.map((t) => swapThread(t, c)) };
    });
    setDays((m) => {
      let touched = false;
      const next = new Map(m);
      for (const [day, cards] of m) {
        if (!cards.some((x) => x.id === c.id)) continue;
        next.set(day, cards.map((x) => (x.id === c.id ? c : x)));
        touched = true;
      }
      return touched ? next : m;
    });
    setSettled((s) => (hidden ? s : new Map(s).set(c.id, c)));
  }, []);

  /** A thread acknowledged on screen (UpdateRow): each of its cards, at `at`, or put back with null when the head refused. */
  const acknowledged = useCallback(
    (ids: string[], at: string | null) => {
      const set = <T extends { id: string; acknowledged_at?: string }>(x: T): T => {
        if (!ids.includes(x.id)) return x;
        const { acknowledged_at: _, ...rest } = x;
        return (at ? { ...x, acknowledged_at: at } : rest) as T;
      };
      const known = new Map<string, MeCard>();
      setBrief((b) => {
        if (!b) return b;
        for (const t of b.threads) if (ids.includes(t.latest.id)) known.set(t.latest.id, set(t.latest));
        return { ...b, threads: b.threads.map((t) => ({ ...t, latest: set(t.latest), cards: t.cards.map(set) })) };
      });
      setDays((m) => {
        const next = new Map<string, MeCard[]>();
        for (const [day, cards] of m) {
          next.set(day, cards.map(set));
          for (const c of cards) if (ids.includes(c.id)) known.set(c.id, set(c));
        }
        return next;
      });
      setSettled((s) => {
        const next = new Map(s);
        for (const c of known.values()) next.set(c.id, c);
        return next;
      });
    },
    [],
  );

  const select = useCallback((d: string) => setSelected(d === today ? null : d), [today]);

  const dayCards = date ? days.get(date) : undefined;
  const column = useMemo<BriefColumn | null>(() => {
    if (!brief || !date) return null;
    if (date === brief.date) return keepSettled(todayColumn(brief), settled);
    return dayCards ? dayColumn(date, dayCards) : null;
  }, [brief, date, dayCards, settled]);
  const rail = useMemo(() => (dayCards ? railCards(dayCards) : null), [dayCards]);
  // §8 pairing: what the loaded cards reference, from every loaded day and today's brief.
  const references = useMemo(() => {
    const all = new Map<string, MeCard>();
    for (const cards of days.values()) for (const c of cards) all.set(c.id, c);
    for (const c of brief?.threads.map((t) => t.latest) ?? []) all.set(c.id, c);
    return referencedBy(all.values());
  }, [days, brief]);

  return { brief, today, date, select, column, rail, references, cachedAt, error, change, acknowledged };
}

/** A thread with one card changed: its newest, or one of the earlier ones (by what the row lists of them). */
function swapThread(t: BriefResponse['threads'][number], c: MeCard): BriefResponse['threads'][number] {
  if (t.latest.id === c.id) return { ...t, latest: c };
  if (!t.cards.some((e) => e.id === c.id)) return t;
  return { ...t, cards: t.cards.map((e) => (e.id === c.id ? { ...e, ...(c.acknowledged_at ? { acknowledged_at: c.acknowledged_at } : {}) } : e)) };
}

/**
 * Today's column with what the person settled here kept in it: a decision decided, or a thread acknowledged, that a
 * reload of the brief no longer lists stays, in its new state, at the end of its list. Open decisions newest first.
 */
function keepSettled(column: BriefColumn, settled: Map<string, MeCard>): BriefColumn {
  const shown = new Set([...column.decisions.map((c) => c.id), ...column.threads.flatMap((t) => [t.latest.id, ...t.earlier.map((e) => e.id)])]);
  const gone = [...settled.values()].filter((c) => !shown.has(c.id));
  return {
    ...column,
    decisions: [...column.decisions, ...gone.filter((c) => c.kind === 'decision' && c.state === 'decided')],
    threads: [...column.threads, ...threads(gone.filter((c) => isUpdate(c) && c.acknowledged_at))],
  };
}
