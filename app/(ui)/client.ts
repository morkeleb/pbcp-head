'use client';

// The web head's one data path: /api/me with `Authorization: Session`, the same calls the phone makes
// (mobile PRD). Tokens from sign-in live in localStorage; an expired access token is refreshed once. Every
// call says which zone the browser is in (X-Timezone), so the head follows the owner when they travel.
//
// Offline (lib/pwa/service-worker.ts): reads may be answered from the service worker's cache, and then carry
// `cachedAt`, the time that copy was fetched; the page says "as of" it. Writes (decide, acknowledge, snooze,
// orders) are never sent without a network and never queued: api() refuses them with OfflineError, and the
// controls are disabled while offline.

import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  device_id: string;
  head: string;
}

const KEY = 'pbcp.session';

export function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function saveTokens(t: Tokens | null): void {
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the session lasts as long as the page
  }
  // Signed out: the cached brief and cards belong to the session that read them.
  if (!t && typeof caches !== 'undefined') void clearCachedData();
}

async function clearCachedData(): Promise<void> {
  try {
    for (const name of ['pbcp-data', 'pbcp-pages', 'pbcp-media']) await caches.delete(name);
  } catch {
    // no Cache API
  }
}

// --- online / offline --------------------------------------------------------------------------------

/** Why a write control is disabled offline. */
export const OFFLINE_REASON = 'You’re offline. Deciding, acknowledging, snoozing and giving orders need a connection, and nothing is saved to send later.';

/** A write that was not sent because there is no network. */
export class OfflineError extends Error {
  constructor() {
    super('offline: not sent, and not queued');
  }
}

let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
const watchers = new Set<() => void>();
function setOffline(value: boolean): void {
  if (offline === value) return;
  offline = value;
  for (const w of watchers) w();
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOffline(false));
  window.addEventListener('offline', () => setOffline(true));
}

/** Whether the browser has a network, by its own account and by the last request's. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => !offline,
    () => true,
  );
}

/**
 * Live: calls `reload` when the head has changed since the page last looked. It asks the head's change counter
 * (GET /api/me/seq) when the page comes back into view, every `everyMs` while it is on screen, and at once when a push
 * arrives (the service worker says so), and reloads only when the counter has moved. The brief keeps its own check
 * (brief/use-brief.ts), which also follows the date.
 */
export function useLiveChanges(reload: () => Promise<void> | void, everyMs = 60_000): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    let seq: number | null = null;
    let last = 0;
    let busy = false;
    const check = async (now = false) => {
      if (document.visibilityState !== 'visible' || busy) return;
      if (!now && Date.now() - last < Math.min(everyMs, 15_000)) return;
      last = Date.now();
      busy = true;
      try {
        const r = await api<{ seq: number }>('/api/me/seq', { network: true });
        if (r.status !== 200) return;
        if (seq !== null && r.body.seq !== seq) await latest.current();
        seq = r.body.seq;
      } catch {
        // offline, or signed out: the next check tries again
      } finally {
        busy = false;
      }
    };
    const onVisible = () => void check();
    const onMessage = (e: MessageEvent) => void ((e.data as { type?: string } | null)?.type === 'pbcp-push' && check(true));
    void check(true); // where the counter is now: changes are counted from here
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    const timer = setInterval(() => void check(true), everyMs);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      clearInterval(timer);
    };
  }, [everyMs]);
}

/**
 * The service worker answered `path` from its cache and then got the network's answer: `onFresh` gets the new
 * body. When the network refused (an expired session), `onStale` should ask again with `network: true`.
 */
export function useFresh(path: string | null, onFresh: (body: any) => void, onStale: () => void): void {
  useEffect(() => {
    if (!path || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const url = new URL(path, location.origin).href;
    const listen = (e: MessageEvent) => {
      const m = e.data as { type?: string; url?: string; body?: string };
      if (m?.url !== url) return;
      if (m.type === 'pbcp-fresh') onFresh(JSON.parse(m.body!));
      else if (m.type === 'pbcp-stale') onStale();
    };
    navigator.serviceWorker.addEventListener('message', listen);
    return () => navigator.serviceWorker.removeEventListener('message', listen);
  }, [path, onFresh, onStale]);
}

let refreshing: Promise<Tokens | null> | null = null;

async function refresh(t: Tokens): Promise<Tokens | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: t.refresh_token }) })
    .then(async (r) => (r.ok ? ((await r.json()) as Tokens) : null))
    .catch(() => null)
    .then((next) => {
      saveTokens(next);
      refreshing = null;
      return next;
    });
  return refreshing;
}

export function signInAgain(): never {
  saveTokens(null);
  location.href = `/signin?next=${encodeURIComponent(location.pathname + location.search)}`;
  throw new Error('signed out');
}

/** The browser's IANA zone as `X-Timezone`, or nothing when it does not know one. */
function browserZone(): Record<string, string> {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? { 'x-timezone': zone } : {};
  } catch {
    return {};
  }
}

export interface ApiResult<T> {
  status: number;
  body: T;
  /** Set when the service worker answered from its cache: when that copy was fetched (RFC 3339). */
  cachedAt?: string;
}

/**
 * A sandbox answers every call in place of the head: the front door's demo brief (app/about) runs the brief's real
 * components with one, so deciding or acknowledging settles the card for that visitor and sends nothing. No session is
 * read and nothing leaves the page while it is set.
 */
export type Sandbox = (path: string, init: { method: string; body?: unknown }) => ApiResult<any>;
let sandbox: Sandbox | null = null;
export const setSandbox = (s: Sandbox | null) => void (sandbox = s);

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean; network?: boolean } = {}): Promise<ApiResult<T>> {
  const method = init.method ?? 'GET';
  if (sandbox) return sandbox(path, { method, ...(init.body !== undefined ? { body: init.body } : {}) }) as ApiResult<T>;
  // A write is sent now or not at all: never without a network, never queued for later.
  if (method !== 'GET' && (offline || navigator.onLine === false)) throw new OfflineError();
  let tokens = loadTokens();
  if (!tokens) signInAgain();
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        keepalive: init.keepalive,
        headers: {
          authorization: `Session ${tokens!.access_token}`,
          ...browserZone(),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init.network || attempt > 0 ? { 'x-pbcp-network': '1' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      setOffline(true);
      if (method !== 'GET') throw new OfflineError();
      return { status: 0, body: { error: 'offline', message: e instanceof Error ? e.message : 'no network' } as T };
    }
    if (res.headers.get('x-pbcp-offline')) setOffline(true);
    else if (!res.headers.get('x-pbcp-from-cache')) setOffline(false);
    if (res.status === 401 && attempt === 0) {
      tokens = await refresh(tokens!);
      if (!tokens) signInAgain();
      continue;
    }
    const text = await res.text();
    const cachedAt = res.headers.get('x-pbcp-from-cache') ? (res.headers.get('x-pbcp-fetched-at') ?? undefined) : undefined;
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, ...(cachedAt ? { cachedAt } : {}) };
  }
  return signInAgain();
}

export const cardHref = (id: string) => `/card/${encodeURIComponent(id)}`;

export function when(iso: string, timezone?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
