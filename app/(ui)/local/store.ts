'use client';

// The projection (docs/local-first.md): the head's cards as snapshots, by id, each the newest the device has seen
// (latest change_seq wins), with what the outbox has not sent yet laid over them when they are read. The index
// (search.ts) and the day view (brief/use-brief.ts) are projections of this one.
//
// Events are snapshots, not deltas: applying a card replaces the stored copy whole, so a device can join at any cursor
// and an evicted store rebuilds from the feed (feed.ts). Nothing here talks to the head.

import { loadTokens } from '../client';
import type { Command } from './commands.generated';
import { CARDS, done, dropStore, META, OUTBOX, withStore } from './db';
import type { MeCard, Meta, MetaKey, OutboxRow } from './model.generated';

/** A command not yet sent (outbox.ts), as the store lays it over a card: the model's (model/model.json). */
export type { OutboxRow };
export const owner = (): string | null => loadTokens()?.head ?? null;

// --- change notifications, this tab and the others ---------------------------------------------------------------

type Listener = (e: { cards?: string[]; outbox?: true; meta?: string }) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel('pbcp-store');
  channel.onmessage = (m) => listeners.forEach((l) => l(m.data));
}

/** Tells this tab and the others what changed in the store. */
export function notify(e: Parameters<Listener>[0]): void {
  listeners.forEach((l) => l(e));
  try {
    channel?.postMessage(e);
  } catch {
    // a closed channel
  }
}

export function onStore(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// --- meta ----------------------------------------------------------------------------------------------------------

export async function getMeta<K extends MetaKey>(key: K): Promise<Meta[K] | null> {
  const o = owner();
  if (!o) return null;
  const row = await withStore(o, [META], 'readonly', (t) => done(t.objectStore(META).get(key)));
  return (row as { value?: Meta[K] } | null | undefined)?.value ?? null;
}

export async function setMeta<K extends MetaKey>(key: K, value: Meta[K]): Promise<boolean> {
  const o = owner();
  if (!o) return false;
  const ok = await withStore(o, [META], 'readwrite', (t) => {
    t.objectStore(META).put({ key, value });
    return true;
  });
  if (ok) notify({ meta: key });
  return ok === true;
}

// --- cards ---------------------------------------------------------------------------------------------------------

/**
 * Applies snapshots latest-wins by id: a card replaces the stored copy unless that copy is newer (a higher change_seq).
 * `force` replaces regardless (the head's answer to a command, or a recomputed sensitivity). Returns the ids it changed.
 */
export async function putCards(cards: MeCard[], { force = false }: { force?: boolean } = {}): Promise<string[] | null> {
  const o = owner();
  if (!o || cards.length === 0) return cards.length === 0 ? [] : null;
  const changed = await withStore(o, [CARDS], 'readwrite', async (t) => {
    const s = t.objectStore(CARDS);
    const ids: string[] = [];
    for (const c of cards) {
      const prev = (await done(s.get(c.id))) as MeCard | undefined;
      if (!force && prev && prev.change_seq > c.change_seq) continue;
      // A reply that carries only the protocol card (a decision's answer, a 409's stored card) keeps what the head rendered;
      // without a copy to complete, it is not a snapshot the device can show, and the feed brings the whole card.
      if (!prev && typeof c.rendered_html !== 'string') continue;
      s.put(prev ? { ...prev, ...c } : c);
      ids.push(c.id);
    }
    return ids;
  });
  if (changed && changed.length > 0) notify({ cards: changed });
  return changed;
}

export async function getCard(id: string): Promise<MeCard | null> {
  const o = owner();
  if (!o) return null;
  const c = (await withStore(o, [CARDS], 'readonly', (t) => done(t.objectStore(CARDS).get(id)))) as MeCard | undefined | null;
  return c ? overlay(c, await pending()) : null;
}

/** Every stored card whose day (§8) is in [from, to], with the outbox laid over; null without a store. */
export async function cardsByDay(from: string, to: string = from): Promise<MeCard[] | null> {
  const o = owner();
  if (!o) return null;
  const cards = (await withStore(o, [CARDS], 'readonly', (t) => done(t.objectStore(CARDS).index('day').getAll(IDBKeyRange.bound(from, to))))) as MeCard[] | null;
  if (!cards) return null;
  const rows = await pending();
  return cards.map((c) => overlay(c, rows));
}

export async function allCards(): Promise<MeCard[] | null> {
  const o = owner();
  if (!o) return null;
  return (await withStore(o, [CARDS], 'readonly', (t) => done(t.objectStore(CARDS).getAll()))) as MeCard[] | null;
}

/** Removes every card whose day is before `day` (retention); returns their ids. */
export async function evictBefore(day: string): Promise<string[]> {
  const o = owner();
  if (!o) return [];
  const ids = await withStore(o, [CARDS], 'readwrite', async (t) => {
    const s = t.objectStore(CARDS);
    const keys = (await done(s.index('day').getAllKeys(IDBKeyRange.upperBound(day, true)))) as string[];
    for (const k of keys) s.delete(k);
    return keys;
  });
  if (ids && ids.length > 0) notify({ cards: ids });
  return ids ?? [];
}

// --- the outbox, as the store reads it -----------------------------------------------------------------------------

export async function pending(): Promise<OutboxRow[]> {
  const o = owner();
  if (!o) return [];
  return ((await withStore(o, [OUTBOX], 'readonly', (t) => done(t.objectStore(OUTBOX).getAll()))) as OutboxRow[] | null) ?? [];
}

/** What a command does to a card on the device, at once, before the head has it: the card settles as it would online. */
export function apply(c: MeCard, row: Pick<OutboxRow, 'action' | 'body' | 'at'>): MeCard {
  const b = row.body as Partial<Extract<Command, { action: 'decide' }>['body']> & { until?: string | null; preset?: string };
  switch (row.action) {
    case 'decide':
      return { ...c, state: 'decided', decision: b.decision!, decided_at: row.at, ...(b.edited_proposal ? { edited_proposal: b.edited_proposal } : {}), ...(b.comment ? { comment: b.comment } : {}) };
    case 'ack':
      return { ...c, acknowledged_at: row.at };
    case 'snooze':
      return { ...c, snoozed_until: b.until ?? presetUntil(b.preset ?? 'tomorrow', new Date(row.at)) };
    case 'unsnooze': {
      const { snoozed_until: _s, ...rest } = c;
      return rest as MeCard;
    }
  }
}

/** The card with every unsent command for it laid over, in order. */
export function overlay(c: MeCard, rows: OutboxRow[]): MeCard {
  return rows.filter((r) => r.card_id === c.id).reduce(apply, c);
}

/**
 * Where a snooze preset lands, on the device's clock, until the head answers with its own (lib/settings-me.ts
 * snoozeUntil: tonight 18:00, tomorrow's brief 05:30, next week 05:30, in the head's zone).
 */
export function presetUntil(preset: string, now: Date): string {
  const at = (days: number, h: number, m: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  if (preset === 'tonight') return now.getHours() < 18 ? at(0, 18, 0) : at(1, 18, 0);
  if (preset === 'next-week') return at(7, 5, 30);
  return at(1, 5, 30);
}

// --- size, and signing out -----------------------------------------------------------------------------------------

/** The origin's storage use, as the browser estimates it; null when it will not say. */
export async function storeSize(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted } : null;
  } catch {
    return null;
  }
}

/** Signed out: the device's copy belongs to the session that read it. */
export async function forget(head: string): Promise<void> {
  await dropStore(head);
}

/**
 * A response the head composed (the brief), as the device shows it: every card in it, at any depth, replaced by the
 * store's copy when that is newer, and the outbox laid over. The composition (its paragraph, folds and order) is the
 * head's; the cards are the device's.
 */
export async function project<T>(v: T): Promise<T> {
  const o = owner();
  if (!o) return v;
  const ids = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    const r = x as Record<string, unknown>;
    if (typeof r.id === 'string' && typeof r.producer === 'string' && typeof r.change_seq === 'number') ids.add(r.id);
    Object.values(r).forEach(walk);
  };
  walk(v);
  const stored = new Map<string, MeCard>();
  await withStore(o, [CARDS], 'readonly', async (t) => {
    const s = t.objectStore(CARDS);
    for (const id of ids) {
      const c = (await done(s.get(id))) as MeCard | undefined;
      if (c) stored.set(id, c);
    }
  });
  const rows = await pending();
  const swap = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(swap);
    if (!x || typeof x !== 'object') return x;
    const r = Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, swap(y)])) as Record<string, unknown>;
    if (typeof r.id === 'string' && ids.has(r.id) && typeof r.change_seq === 'number') {
      const s = stored.get(r.id);
      const base = (s && s.change_seq >= (r.change_seq as number) ? { ...r, ...s } : r) as unknown as MeCard;
      return overlay(base, rows);
    }
    return r;
  };
  return swap(v) as T;
}
