// Runs before the pages (Next.js Proxy): a fresh CSP nonce per request (lib/security.ts). Next.js puts the
// nonce on its own scripts, so the pages run no script without it, and rendered card HTML can run none.
//
// API routes are deliberately not matched. Next.js buffers a request's body (up to 10 MB) before running a
// proxy on it, so a 413 here would come after reading more of the body than the routes do: they refuse a
// declared oversized body before reading any of it (lib/http.ts readBody), in §7.1's order.

import { NextResponse, type NextRequest } from 'next/server';
import { prefersHtml } from './lib/accept';
import { COMMON_HEADERS, pageCsp } from './lib/security';

export function proxy(req: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const csp = pageCsp(nonce);
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  // GET / is the describe JSON (RFC §7.5, app/route.ts) for producers and anything that does not ask otherwise; a
  // browser, preferring text/html over application/json, gets the head's front door (app/about) instead.
  const root = req.nextUrl.pathname === '/';
  const res =
    root && prefersHtml(req.headers.get('accept'))
      ? NextResponse.rewrite(new URL('/about', req.url), { request: { headers } })
      : NextResponse.next({ request: { headers } });
  if (root) res.headers.set('vary', 'Accept');
  res.headers.set('content-security-policy', csp);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) res.headers.set(k, v);
  return res;
}

export const config = {
  // Pages only. Static assets, icons and the manifest have no script to protect; the service worker sends its
  // own policy (app/sw.js); /api gets its headers from next.config.ts.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|icons/|sw.js|manifest.webmanifest).*)'],
};
