'use client';

// The brief's data, one day at a time: today (GET /api/me/brief), tomorrow (from the brief) and the days after it, up to
// two weeks ahead, and any earlier day the person goes to (GET /api/me/cards?date=, loaded when it is first shown; §8:
// every card stays reachable). Each day's schedule (its cards with `at`, RFC 0.8 §8) comes from its cards: an earlier
// day's as loaded, today's and the days ahead from GET /api/me/cards?from=&to=, since the brief leaves `log` cards out.
// A day is shaped once here, the same at every width: its paragraph, its decisions, its schedule, its updates
// (artifacts) and signals as threads.
//
// Local first (docs/local-first.md): everything is read from the device's store before the head is asked. A cold open
// shows the brief the head last composed, kept on the device, with its cards from the store and the outbox laid over,
// the dateline marked "as of <time>" until the sync (local/feed.ts) returns. Days within retention come from the store;
// an older day, or a device without a store, is read from the head as before. The head is asked to move the cursor:
// GET /api/me/seq, then the feed and, when its counter or date moved, the brief's composition.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../client';
import type { MeCard } from '../components';
import { byTime } from '../../../lib/time';
import { sync } from '../local/feed';
import { storeBroken } from '../local/db';
import { cardsByDay, getCard, getMeta, onStore, project } from '../local/store';

import { addDays, aheadOf, AHEAD, localDay, pastOf, railCards, referencedBy, todayOf, tomorrowOf, type BriefResponse, type Day } from './days';

export { addDays, type BriefResponse, type Day };

/** How often an open brief asks whether it changed, and the least time between two asks (focus and visibility fire together). */
const LIVE_EVERY_MS = 60_000;
const LIVE_MIN_GAP_MS = 15_000;

export function useBrief() {
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Earlier days the person has gone to, by date: every card of each.
  const [past, setPast] = useState<Map<string, MeCard[]>>(new Map());
  const seq = useRef<number | null>(null);
  /** The day the page shows, for the live check: an earlier one loads again when the head changes. */
  const showing = useRef<string | null>(null);
  // Today's cards and those of the days ahead, every one of them, by day: for their schedules, and for the days after
  // tomorrow, which the brief does not carry. A day jumped to that has none is kept, empty, so it can be shown.
  const [near, setNear] = useState<Map<string, MeCard[]>>(new Map());
  const loadNear = useCallback(async (today: string, tz: string, network = false) => {
    // The store has every day of the window once it has synced.
    const local = (await getMeta<number>('cursor')) !== null ? await cardsByDay(today, addDays(today, AHEAD)) : null;
    const cards: MeCard[] = local ?? [];
    for (let after: number | null = local ? null : 0; after !== null; ) {
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
  /** The brief the head last composed, from the store, its cards the device's; null when the device has none. */
  const fromStore = useCallback(async (): Promise<(BriefResponse & { fetched_at?: string }) | null> => {
    const b = await getMeta<BriefResponse & { fetched_at?: string }>('brief');
    return b ? project(b) : null;
  }, []);
  const loadFromHead = useCallback(async () => {
    const r = await api<BriefResponse>('/api/me/brief', { network: true });
    if (r.status !== 200) return setError(r.status === 0 || r.status === 503 ? 'You’re offline, and this device has no copy of the brief yet.' : `Could not load the brief (${r.status}).`);
    setBrief((prev) => keepPlaces(prev, r.body, settled.current));
    seq.current ??= r.body.seq;
  }, []);
  const load = useCallback(async (network = false, quiet = false) => {
    // Local first: the store's brief, when it has one and the sync just ran (or cannot run: offline, "as of").
    const local = storeBroken() ? null : await fromStore();
    if (local) {
      setBrief((prev) => keepPlaces(prev, local, settled.current));
      seq.current ??= local.seq;
      return;
    }
    const r = await api<BriefResponse>('/api/me/brief', { network });
    // A refresh that fails leaves the brief on screen as it was; only a first load reports.
    if (r.status !== 200 && quiet) return;
    if (r.status !== 200) return setError(r.status === 0 || r.status === 503 ? 'You’re offline, and this device has no copy of the brief yet.' : `Could not load the brief (${r.status}).`);
    setBrief((prev) => keepPlaces(prev, r.body, settled.current));
    setCachedAt(r.cachedAt ?? null);
    seq.current ??= r.body.seq; // the first view sets what "seen" means when the owner leaves
  }, []);
  // A cold open: the device's copy at once, marked "as of"; then the sync, and the brief as it now stands.
  useEffect(() => {
    void (async () => {
      const local = storeBroken() ? null : await fromStore();
      if (local) {
        setBrief((prev) => keepPlaces(prev, local, settled.current));
        setCachedAt(local.fetched_at ?? null);
        seq.current ??= local.seq;
      }
      // A device with no copy yet: the head's brief at once, and the first pull fills the store behind it.
      if (!local) await loadFromHead();
      if (await sync()) {
        await load(true, true);
        setCachedAt(null);
      }
    })();
  }, [load, fromStore, loadFromHead]);
  useEffect(() => void (brief?.date && loadNear(brief.date, brief.timezone)), [brief?.date, brief?.timezone, loadNear]);

  // The store changed (the sync applied cards, the outbox settled or refused one, another tab acted): each card on
  // screen follows, in place.
  const changeRef = useRef<(c: MeCard, fromStore?: boolean) => void>(() => undefined);
  useEffect(
    () =>
      onStore(async (e) => {
        for (const id of e.cards ?? []) {
          const c = await getCard(id);
          if (c) changeRef.current(c, true);
        }
      }),
    [],
  );

  /**
   * Loads an earlier day: every card whose day it is (§8), all pages. Loaded again when the head has changed. False when
   * it could not be loaded (offline with no copy, or the head refused).
   */
  const loadDay = useCallback(async (date: string, network = false): Promise<boolean> => {
    // Within retention (or with the archive), the day is on the device.
    const oldest = await getMeta<string>('oldest_day');
    if (oldest !== null && date >= oldest && (await getMeta<number>('cursor')) !== null) {
      const local = await cardsByDay(date);
      if (local) {
        setPast((m) => new Map(m).set(date, local.sort(byTime)));
        return true;
      }
    }
    const cards: MeCard[] = [];
    for (let after: number | null = 0; after !== null; ) {
      const r: { status: number; body: { cards: MeCard[]; next: number | null } } = await api(`/api/me/cards?date=${date}&limit=200${after ? `&after=${after}` : ''}`, { network }).catch(() => ({ status: 0, body: { cards: [], next: null } }));
      if (r.status !== 200) return false;
      cards.push(...r.body.cards);
      after = r.body.next;
    }
    setPast((m) => new Map(m).set(date, cards));
    return true;
  }, []);

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
        // The sync asks the counter first, and pulls only when it moved (local/feed.ts). Without a store, the counter alone.
        const synced = storeBroken() ? false : await sync();
        const r = synced ? { status: 200, body: (await getMeta<{ seq: number; date: string }>('brief'))! } : await api<{ seq: number; date: string }>('/api/me/seq', { network: true });
        if (synced) setCachedAt(null);
        const b = current.current;
        if (r.status === 200 && r.body && b && (r.body.seq !== b.seq || r.body.date !== b.date)) {
          await load(true, true);
          await loadNear(r.body.date, b.timezone, true);
          // An earlier day on screen loads again; the others when they are next shown.
          const shown = showing.current;
          setPast((m) => (shown && m.has(shown) ? new Map([[shown, m.get(shown)!]]) : new Map()));
          if (shown && shown < r.body.date) await loadDay(shown, true);
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
  }, [load, loadNear, loadDay]);

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
   * A card changed on screen (decided, seen, snoozed, or rolled back): the same card everywhere it is shown. `fromStore`:
   * the store applied it (the sync, the outbox, another tab), so it says nothing about whether this brief is current.
   */
  const change = useCallback((c: MeCard, fromStore = false) => {
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
      const seq = !fromStore && c.change_seq === b.seq + 1 ? c.change_seq : b.seq;
      // A task closed here stays in today's list, ticked, as the brief lists it again (RFC 0.9 §4.5); snoozed, it leaves.
      const tasks = c.kind !== 'task' || !b.tasks ? b.tasks : hidden ? b.tasks.filter((t) => t.id !== c.id) : b.tasks.map((t) => (t.id === c.id ? c : t));
      return { ...b, seq, decisions, ...(tasks ? { tasks } : {}), tomorrow: { ...b.tomorrow, cards: tomorrowCards } };
    });
    const swap = (m: Map<string, MeCard[]>) => {
      let touched = false;
      const next = new Map(m);
      for (const [date, cards] of m) {
        if (!cards.some((x) => x.id === c.id)) continue;
        next.set(date, cards.map((x) => (x.id === c.id ? c : x)));
        touched = true;
      }
      return touched ? next : m;
    };
    setNear(swap);
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

  changeRef.current = change;

  const withRail = (d: Day): Day => (near.has(d.date) ? { ...d, rail: railCards(near.get(d.date)!), cards: near.get(d.date)! } : d);
  /**
   * The day `date` as the page shows it: today and tomorrow from the brief (with their schedules), a later day from the
   * days ahead, an earlier one once loaded (null until then: `loadDay`).
   */
  const dayOf = (date: string): Day | null => {
    if (!brief) return null;
    if (date === brief.date) return withRail(todayOf(brief, near.get(brief.date)));
    if (date === addDays(brief.date, 1)) return withRail(tomorrowOf(brief));
    if (date > brief.date) return aheadOf(date, near.get(date) ?? [], brief.timezone);
    return past.has(date) ? pastOf(date, past.get(date)!) : null;
  };
  // §8 pairing: the later cards that reference a card, from everything loaded.
  const references = referencedBy([...past.values(), ...near.values()].flat());
  return { brief, dayOf, loadDay, references, cachedAt, error, change, showing };
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
