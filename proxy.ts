// Runs before the pages (Next.js Proxy): a fresh CSP nonce per request (lib/security.ts). Next.js puts the
// nonce on its own scripts, so the pages run no script without it, and rendered card HTML can run none.
//
// API routes are deliberately not matched. Next.js buffers a request's body (up to 10 MB) before running a
// proxy on it, so a 413 here would come after reading more of the body than the routes do: they refuse a
// declared oversized body before reading any of it (lib/http.ts readBody), in §7.1's order.

import { NextResponse, type NextRequest } from 'next/server';
import { COMMON_HEADERS, pageCsp } from './lib/security';

export function proxy(req: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const csp = pageCsp(nonce);
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) res.headers.set(k, v);
  return res;
}

export const config = {
  // Pages only. Static assets, icons and the manifest have no script to protect; the service worker sends its
  // own policy (app/sw.js); /api gets its headers from next.config.ts.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|icons/|sw.js|manifest.webmanifest).*)'],
};
