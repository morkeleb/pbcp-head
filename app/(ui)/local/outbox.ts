'use client';

// The command outbox (docs/local-first.md): the only thing on the device that writes to the head. Decide (done and a
// comment included), acknowledge, snooze and unsnooze settle the card on the device at once, as online, and append a row:
// the card id, the action and its payload, the card's change_seq as seen, a client id and the time. A sender drains the
// rows in order whenever the device is online, under a web lock so two tabs never send the same row, through the
// existing owner routes. The routes are idempotent on the card (a decision on a decided card is 409; a repeated
// acknowledgement changes nothing), so a replay after a crash is safe.
//
//   2xx                        the row leaves; the head's card replaces the device's
//   409 (decided or replaced)  the head's state wins, the row is dropped, the card says "decided on another device: …"
//   403 reauthentication_required (a confirm card)
//                              the row waits, and every row behind it; the card says "needs your passkey to confirm";
//                              confirming runs the step-up and sends it again
//   any other 4xx              the row is dropped, the card goes back to the head's state, and a line says what was refused
//   no network, or 5xx         the row stays; tried again after 1 s, 10 s, 1 min, then every 5 min while the app is open
//
// A row is never reordered: the person decided them in that order. The outbox is the device's, never synced: a decision
// made offline here is this device's to send; the others learn of it through the head like any other change.

import { api } from '../client';
import type { MeCard } from '../components';
import { OUTBOX, withStore } from './db';
import { getCard, notify, onStore, owner, pending, putCards, type OutboxRow } from './store';

const BACKOFF_MS = [1_000, 10_000, 60_000, 300_000];

/** What became of a command, for the control that made it. */
export type Outcome =
  | { kind: 'sent'; card: MeCard }
  | { kind: 'conflict'; card: MeCard; message?: string }
  | { kind: 'needs-person' }
  | { kind: 'refused'; status: number; message: string }
  /** Not sent yet (offline, or behind a row that waits): the card stays settled on the device. */
  | { kind: 'waiting' };

/** A line the card shows about what happened to the person's action out of sight (409, 403, a refusal). */
export interface Notice {
  kind: 'conflict' | 'needs-person' | 'refused';
  text: string;
}

// One-off lines (a conflict, a refusal) live for the session. The waiting state of a confirm row does not: it is read from
// the row itself (`status: 'needs-person'`, kept in IndexedDB), so a reload still says why the card, and every row behind
// it, waits.
const notices = new Map<string, Notice>();
const noticeWatchers = new Set<() => void>();
/** Cards whose outbox row waits for the passkey, as the outbox holds them now. */
let blocked = new Set<string>();
const NEEDS_PERSON: Notice = { kind: 'needs-person', text: 'Needs your passkey to confirm.' };
function setNotice(cardId: string, n: Notice | null) {
  if (n) notices.set(cardId, n);
  else notices.delete(cardId);
  noticeWatchers.forEach((w) => w());
}
/** Re-reads which rows wait for the passkey, and tells the cards. */
async function refreshBlocked(): Promise<void> {
  const next = new Set((await pending()).filter((r) => r.status === 'needs-person').map((r) => r.card_id));
  if (next.size === blocked.size && [...next].every((id) => blocked.has(id))) return;
  blocked = next;
  noticeWatchers.forEach((w) => w());
}
export const noticeFor = (cardId: string): Notice | null => notices.get(cardId) ?? (blocked.has(cardId) ? NEEDS_PERSON : null);
export function onNotices(w: () => void): () => void {
  noticeWatchers.add(w);
  // The first card to listen reads the outbox: a row that was waiting before the reload is waiting still.
  if (noticeWatchers.size === 1) void refreshBlocked();
  return () => noticeWatchers.delete(w);
}

const waiters = new Map<string, (o: Outcome) => void>();
const settle = (clientId: string, o: Outcome) => {
  waiters.get(clientId)?.(o);
  waiters.delete(clientId);
};

const PATHS: Record<OutboxRow['action'], string> = { decide: 'decision', ack: 'ack', snooze: 'snooze', unsnooze: 'unsnooze' };
const PAST: Record<string, string> = { approve: 'approved', reject: 'rejected', dismissed: 'dismissed', edited: 'edited', delegated: 'delegated', done: 'done' };

/** Whether the device can hold an outbox (a store); without one, commands go straight to the head as before. */
export async function hasOutbox(): Promise<boolean> {
  const o = owner();
  return !!o && (await withStore(o, [OUTBOX], 'readonly', () => true)) === true;
}

/**
 * Records a command and asks the sender to drain. Resolves with what became of this row: `sent`, `conflict`,
 * `needs-person` or `refused` once the head answered, or `waiting` when it could not be sent now (offline, or behind a
 * row that waits). Null when the device has no store: the caller sends it the old way.
 */
export async function command(card: Pick<MeCard, 'id' | 'title'> & { change_seq?: number }, action: OutboxRow['action'], body: Record<string, unknown> = {}): Promise<Outcome | null> {
  const o = owner();
  if (!o) return null;
  const row: OutboxRow = {
    client_id: crypto.randomUUID(),
    card_id: card.id,
    action,
    body,
    seen_seq: card.change_seq ?? 0,
    at: new Date().toISOString(),
    status: 'pending',
    tries: 0,
    title: card.title,
  };
  const ok = await withStore(o, [OUTBOX], 'readwrite', (t) => {
    t.objectStore(OUTBOX).add(row);
    return true;
  });
  if (!ok) return null;
  setNotice(card.id, null);
  notify({ outbox: true, cards: [card.id] });
  const outcome = new Promise<Outcome>((resolve) => waiters.set(row.client_id, resolve));
  void drain();
  // The sender answers for this row when the head does; while it cannot reach the head, the row waits.
  return Promise.race([outcome, new Promise<Outcome>((r) => setTimeout(() => r({ kind: 'waiting' }), 8_000))]);
}

/** How many rows wait to be sent. */
export async function waitingCount(): Promise<number> {
  return (await pending()).length;
}

async function remove(seq: number): Promise<void> {
  const o = owner();
  if (o) await withStore(o, [OUTBOX], 'readwrite', (t) => void t.objectStore(OUTBOX).delete(seq));
  await refreshBlocked();
  notify({ outbox: true });
}

async function update(row: OutboxRow): Promise<void> {
  const o = owner();
  if (o) await withStore(o, [OUTBOX], 'readwrite', (t) => void t.objectStore(OUTBOX).put(row));
  await refreshBlocked();
  notify({ outbox: true });
}

let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let draining: Promise<void> | null = null;

/** Sends what waits, in order, once. Another call while one runs joins it. */
export function drain(): Promise<void> {
  draining ??= (async () => {
    try {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      if (locks) await locks.request('pbcp-outbox', sendAll);
      else await sendAll();
    } finally {
      draining = null;
    }
  })();
  return draining;
}

function retryLater() {
  if (timer) return;
  const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  attempt++;
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, wait);
}

async function sendAll(): Promise<void> {
  // Read under the lock: another tab may have sent some since this one looked.
  const rows = (await pending()).sort((a, b) => a.seq! - b.seq!);
  for (const row of rows) {
    if (row.status === 'needs-person') {
      // The rows behind it wait: they were decided after it.
      for (const r of rows) if (r.seq! > row.seq!) settle(r.client_id, { kind: 'waiting' });
      return;
    }
    const path = `/api/me/cards/${encodeURIComponent(row.card_id)}/${PATHS[row.action]}`;
    let r: { status: number; body: any };
    try {
      r = await api(path, { method: 'POST', body: row.action === 'ack' || row.action === 'unsnooze' ? undefined : row.body, network: true });
    } catch {
      r = { status: 0, body: null };
    }
    if (r.status === 0 || r.status >= 500) {
      await update({ ...row, tries: row.tries + 1 });
      for (const x of rows) if (x.seq! >= row.seq!) settle(x.client_id, { kind: 'waiting' });
      return retryLater();
    }
    attempt = 0;
    if (r.status >= 200 && r.status < 300) {
      if (r.body && typeof r.body === 'object' && r.body.id) await putCards([r.body as MeCard], { force: true });
      await remove(row.seq!);
      setNotice(row.card_id, null);
      settle(row.client_id, { kind: 'sent', card: ((await getCard(row.card_id)) ?? r.body) as MeCard });
      continue;
    }
    if (r.status === 409 && r.body && typeof r.body === 'object' && r.body.id) {
      // Decided or replaced elsewhere: the head's state wins, and the card says so.
      await putCards([r.body as MeCard], { force: true });
      await remove(row.seq!);
      const head = r.body as MeCard & { message?: string };
      const text = head.message ?? (head.state === 'decided' ? `Decided on another device: ${PAST[head.decision ?? ''] ?? head.decision}.` : 'This card was replaced on the head.');
      setNotice(row.card_id, { kind: 'conflict', text });
      settle(row.client_id, { kind: 'conflict', card: ((await getCard(row.card_id)) ?? head) as MeCard, message: text });
      continue;
    }
    if (r.status === 403 && r.body?.error === 'reauthentication_required') {
      await update({ ...row, status: 'needs-person' });
      setNotice(row.card_id, { kind: 'needs-person', text: 'Needs your passkey to confirm.' });
      settle(row.client_id, { kind: 'needs-person' });
      for (const x of rows) if (x.seq! > row.seq!) settle(x.client_id, { kind: 'waiting' });
      return;
    }
    // Any other refusal: dropped, the card back to the head's state, and a line says what.
    await remove(row.seq!);
    const message = r.body?.message ?? `the head refused it (${r.status})`;
    setNotice(row.card_id, { kind: 'refused', text: `Not recorded: ${message}` });
    notify({ cards: [row.card_id] });
    settle(row.client_id, { kind: 'refused', status: r.status, message });
  }
}

/** The person confirmed with their passkey (step-up.tsx): the waiting row for this card goes again, then those behind. */
export async function resume(cardId: string): Promise<Outcome> {
  const row = (await pending()).find((r) => r.card_id === cardId && r.status === 'needs-person');
  if (!row) return { kind: 'waiting' };
  await update({ ...row, status: 'pending' });
  setNotice(cardId, null);
  const outcome = new Promise<Outcome>((resolve) => waiters.set(row.client_id, resolve));
  void drain();
  return Promise.race([outcome, new Promise<Outcome>((r) => setTimeout(() => r({ kind: 'waiting' }), 8_000))]);
}

/** The person gave up on a waiting command (cancelled the step-up for it, online): it is dropped, the card reverts. */
export async function discard(cardId: string): Promise<void> {
  for (const row of await pending()) if (row.card_id === cardId) await remove(row.seq!);
  setNotice(cardId, null);
  notify({ cards: [cardId] });
  void drain(); // the rows behind it may go now
}

// The sender runs whenever the device comes back online, when another tab adds a row, and when the app opens.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    attempt = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    void drain();
  });
  onStore((e) => {
    if (!e.outbox) return;
    void refreshBlocked(); // another tab's rows too
    if (!draining && !timer) void drain();
  });
}

/** The first row that waits for the passkey, when it is the one at the head of the outbox (and so blocks the rest). */
export async function blockedBy(): Promise<{ card_id: string; title: string } | null> {
  const first = (await pending()).sort((a, b) => a.seq! - b.seq!)[0];
  return first?.status === 'needs-person' ? { card_id: first.card_id, title: first.title } : null;
}

/** Whether a store row is a draft of this card (for a card's "waiting to send" mark). */
export async function isWaiting(cardId: string): Promise<boolean> {
  return (await pending()).some((r) => r.card_id === cardId);
}

