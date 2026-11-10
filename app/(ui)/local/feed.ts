'use client';

// The event feed (docs/local-first.md): the head's change counter is the log. Each change is a full card snapshot
// stamped with change_seq, read with GET /api/me/cards?after=<cursor> (every state: open, decided, superseded) and
// applied latest-wins by id (store.ts). A sync starts with GET /api/me/seq, so an unchanged counter costs one request.
//
// The first sync pulls the retention window (90 days by default) a week at a time, newest first, so today is on the
// device before the pull finishes, and then catches up from the counter it read before it began. The device's own
// session reads the feed, never an assistant's scoped token: the head strips private cards for an assistant
// (lib/me.ts redactForAssistant), and a store built from that would be incomplete.
//
// Sensitivity: a floor the owner raises changes no card, so the feed cannot carry it. `settings_seq` in /api/me/seq
// moves with every floor change; when it does, the device refetches the floors and recomputes every stored card's
// `effective_sensitivity` with core's `effectiveSensitivity`, the function the head uses (lib/sensitivity.ts).

import { effectiveSensitivity, type Sensitivity } from '@pbcp/core';
import { api } from '../client';
import type { MeCard } from '../components';
import { addDays } from '../brief/days';
import { allCards, evictBefore, getMeta, notify, putCards, setMeta } from './store';

export const RETENTION_DEFAULT = 90;
const WINDOW_DAYS = 7;
/** Days ahead the brief can show (two weeks); the first pull includes them. */
const AHEAD_DAYS = 14;

export interface Floors {
  all: Sensitivity | null;
  producers: Record<string, Sensitivity>;
  labels: Record<string, Sensitivity>;
}

export interface SyncState {
  /** The first pull is running: how many days are on the device, of how many. */
  first?: { days: number; of: number };
  /** When the device last heard from the head. */
  at?: string;
}

let state: SyncState = {};
const watchers = new Set<(s: SyncState) => void>();
const set = (s: SyncState) => {
  state = s;
  watchers.forEach((w) => w(s));
};
export const syncState = () => state;
export function onSync(w: (s: SyncState) => void): () => void {
  watchers.add(w);
  return () => watchers.delete(w);
}

const today = (tz?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** The card's effective sensitivity under the owner's floors (RFC 0.9 §9), as the head computes it. */
export function effectiveUnder(c: Pick<MeCard, 'producer' | 'labels' | 'sensitivity'>, f: Floors): Sensitivity {
  return effectiveSensitivity(c.sensitivity, f.producers[c.producer], ...(c.labels ?? []).map((l) => f.labels[l]), f.all ?? undefined);
}

async function page(query: string): Promise<{ cards: MeCard[]; next: number | null } | null> {
  const r = await api<{ cards: MeCard[]; next: number | null }>(`/api/me/cards?${query}&limit=200`, { network: true }).catch(() => null);
  return r && r.status === 200 ? r.body : null;
}

/** Every card of a query, page by page in change_seq order; false when a page could not be read. */
async function pull(query: string, keep: (c: MeCard) => boolean = () => true): Promise<{ max: number } | null> {
  let max = 0;
  for (let after = 0; ; ) {
    const p = await page(`${query}${after ? `&after=${after}` : ''}`);
    if (!p) return null;
    const cards = p.cards.filter(keep);
    if (cards.length > 0 && (await putCards(cards)) === null) return null;
    for (const c of p.cards) max = Math.max(max, c.change_seq);
    if (p.next === null) return { max };
    after = p.next;
  }
}

let running: Promise<boolean> | null = null;

/**
 * One sync: the counter first; the floors when they moved; the first pull, or the changes since the cursor; then the
 * brief the head composed, when its counter or date moved. False when the head could not be reached or there is no
 * store (the page then reads from the network, as before).
 */
export function sync(): Promise<boolean> {
  running ??= (async () => {
    try {
      return await withLock(syncOnce);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function withLock(fn: () => Promise<boolean>): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request('pbcp-sync', fn) as Promise<boolean>) : fn();
}

async function syncOnce(): Promise<boolean> {
  // No store (a private window, storage refused or evicted mid-session): nothing to sync into; the page reads the head.
  if ((await getMeta<unknown>('probe')) === null && !(await setMeta('probe', true))) return false;
  const stamp = await api<{ seq: number; date: string; settings_seq: number }>('/api/me/seq', { network: true }).catch(() => null);
  if (!stamp || stamp.status !== 200) return false;
  const { seq, date, settings_seq } = stamp.body;
  const cursor = await getMeta<number>('cursor');
  const retention = (await getMeta<number>('retention')) ?? RETENTION_DEFAULT;
  const archive = (await getMeta<boolean>('archive')) === true;
  // The edge of the device's copy: retention, or with the archive whatever it holds (downloadArchive).
  const kept = addDays(date, -retention);
  const oldest = archive ? ((await getMeta<string>('oldest_day')) ?? kept) : kept;

  if ((await getMeta<number>('settings_seq')) !== settings_seq) {
    if (!(await refreshFloors(settings_seq))) return false;
  }

  if (cursor === null) {
    // The first pull: a week at a time from the days ahead back to the edge of retention, newest first.
    const of = AHEAD_DAYS + retention;
    let to = addDays(date, AHEAD_DAYS);
    for (let days = 0; to >= kept; days += WINDOW_DAYS) {
      set({ first: { days: Math.min(days, of), of } });
      const from = addDays(to, -(WINDOW_DAYS - 1));
      if (!(await pull(`from=${from < kept ? kept : from}&to=${to}`))) return set({}), false;
      to = addDays(from, -1);
    }
    if (!(await setMeta('cursor', seq))) return set({}), false;
    await setMeta('oldest_day', kept);
  }
  // The changes since the cursor (or since the first pull began): every state, applied latest-wins. A card older than
  // retention is kept only when it is already on the device.
  const from = (await getMeta<number>('cursor')) ?? seq;
  if (seq > from || cursor === null) {
    const stored = new Set(((await allCards()) ?? []).map((c) => c.id));
    const r = await pull(`after=${from}`, (c) => archive || (c.day ?? "") >= oldest || stored.has(c.id));
    if (!r) return set({}), false;
    await setMeta('cursor', Math.max(seq, r.max));
  }
  // The brief the head composed (its paragraph, folds and lists): kept with the cards, read first on the next open.
  const brief = await getMeta<{ seq: number; date: string }>('brief');
  if (!brief || brief.seq !== seq || brief.date !== date) await refreshBrief();
  if (!archive) await evictBefore(oldest);
  await setMeta('synced_at', new Date().toISOString());
  set({ at: new Date().toISOString() });
  return true;
}

/** GET /api/me/brief, kept on the device as the brief's last composition, stamped with when it was read. */
export async function refreshBrief(): Promise<boolean> {
  const r = await api<{ seq: number; date: string }>('/api/me/brief', { network: true }).catch(() => null);
  if (!r || r.status !== 200) return false;
  return setMeta('brief', { ...r.body, fetched_at: new Date().toISOString() });
}

/** The owner's floors, from GET /api/me/settings, and every stored card's effective sensitivity recomputed under them. */
async function refreshFloors(settingsSeq: number): Promise<boolean> {
  const r = await api<{ sensitivity_floor: Sensitivity | null; sensitivity_floors: { producers: Record<string, Sensitivity>; labels: Record<string, Sensitivity> } }>('/api/me/settings', { network: true }).catch(() => null);
  if (!r || r.status !== 200) return false;
  const floors: Floors = { all: r.body.sensitivity_floor, producers: r.body.sensitivity_floors?.producers ?? {}, labels: r.body.sensitivity_floors?.labels ?? {} };
  await setMeta('floors', floors);
  const cards = (await allCards()) ?? [];
  const changed = cards.filter((c) => effectiveUnder(c, floors) !== c.effective_sensitivity).map((c) => ({ ...c, effective_sensitivity: effectiveUnder(c, floors) }));
  if (changed.length > 0) await putCards(changed, { force: true });
  // The brief's own copies of those cards follow.
  const brief = await getMeta<Record<string, unknown>>('brief');
  if (brief) await setMeta('brief', recompute(brief, floors));
  await setMeta('settings_seq', settingsSeq);
  notify({ meta: 'floors' });
  return true;
}

/** Every card-shaped object in a stored response, its effective sensitivity recomputed. */
function recompute<T>(v: T, f: Floors): T {
  if (Array.isArray(v)) return v.map((x) => recompute(x, f)) as T;
  if (!v || typeof v !== 'object') return v;
  const o = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, recompute(x, f)])) as Record<string, unknown>;
  if (typeof o.id === 'string' && typeof o.producer === 'string' && 'effective_sensitivity' in o) o.effective_sensitivity = effectiveUnder(o as unknown as MeCard, f);
  return o as T;
}

/**
 * How many days the device keeps (a setting; 90 by default). Fewer: the older days leave the store and the index. More:
 * the days now inside it are pulled. The head keeps everything either way.
 */
export async function setRetention(days: number): Promise<boolean> {
  const stamp = await api<{ date: string }>('/api/me/seq', { network: true }).catch(() => null);
  const date = stamp?.status === 200 ? stamp.body.date : today();
  const before = (await getMeta<string>('oldest_day')) ?? date;
  await setMeta('retention', days);
  if ((await getMeta<boolean>('archive')) === true) return true;
  const edge = addDays(date, -days);
  if (edge < before) {
    if (!(await pull(`from=${edge}&to=${addDays(before, -1)}`))) return false;
  } else await evictBefore(edge);
  await setMeta('oldest_day', edge);
  return true;
}

/**
 * "Download the archive": every card back to the head's first, kept whatever the retention, and the browser asked to keep
 * the store (navigator.storage.persist). False when the head could not be reached.
 */
export async function downloadArchive(onProgress?: (days: number, of: number) => void): Promise<boolean> {
  const b = await api<{ first_day: string | null; date: string }>('/api/me/brief', { network: true }).catch(() => null);
  if (!b || b.status !== 200) return false;
  const first = b.body.first_day ?? b.body.date;
  const before = (await getMeta<string>('oldest_day')) ?? b.body.date;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // the browser decides
  }
  const of = Math.max(1, Math.round((Date.parse(before) - Date.parse(first)) / 86_400_000));
  for (let to = addDays(before, -1); to >= first; ) {
    const from = addDays(to, -29) < first ? first : addDays(to, -29);
    if (!(await pull(`from=${from}&to=${to}`))) return false;
    onProgress?.(Math.round((Date.parse(before) - Date.parse(from)) / 86_400_000), of);
    to = addDays(from, -1);
  }
  await setMeta('oldest_day', first);
  await setMeta('archive', true);
  return true;
}

/** Back to retention: the archive is dropped from the device (the head still has it). */
export async function dropArchive(): Promise<void> {
  await setMeta('archive', false);
  const retention = (await getMeta<number>('retention')) ?? RETENTION_DEFAULT;
  await setRetention(retention);
}

/** The floors the device holds, or none. */
export const storedFloors = () => getMeta<Floors>('floors');

export { today };
