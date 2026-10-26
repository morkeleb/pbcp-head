'use client';

// The web head's one data path: /api/me with `Authorization: Session`, the same calls the phone makes
// (mobile PRD). Tokens from sign-in live in localStorage; an expired access token is refreshed once.

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

export interface ApiResult<T> {
  status: number;
  body: T;
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<ApiResult<T>> {
  let tokens = loadTokens();
  if (!tokens) signInAgain();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(path, {
      method: init.method ?? 'GET',
      keepalive: init.keepalive,
      headers: { authorization: `Session ${tokens!.access_token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      tokens = await refresh(tokens!);
      if (!tokens) signInAgain();
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
  return signInAgain();
}

export const cardHref = (id: string) => `/card/${encodeURIComponent(id)}`;

export function when(iso: string, timezone?: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
