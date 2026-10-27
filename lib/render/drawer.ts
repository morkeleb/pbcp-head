// The head draws every diagram through one route, POST /api/render/draw, the only code that loads
// Chromium. On Vercel that makes it a function of its own, with the memory and time a browser needs, while
// every other function stays small; locally and in Docker it is the same server calling itself.
//
// Where the route is: PBCP_DRAW_URL if set; on Vercel, this deployment (VERCEL_URL), or the production
// domain for a production deployment so Deployment Protection does not stand in the way; otherwise this
// server on 127.0.0.1:$PORT.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DiagramError } from './errors';

export const DRAW_PATH = '/api/render/draw';

export function drawUrl(): string {
  if (process.env.PBCP_DRAW_URL) return process.env.PBCP_DRAW_URL;
  if (process.env.VERCEL) {
    const host = (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL) || process.env.VERCEL_URL;
    if (!host) throw new Error('VERCEL_URL is not set; set PBCP_DRAW_URL');
    return `https://${host}${DRAW_PATH}`;
  }
  return `http://127.0.0.1:${process.env.PORT ?? 3000}${DRAW_PATH}`;
}

/** The draw route's credential: neither a producer token nor a session, derived from SESSION_SECRET. */
export function drawKey(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return createHmac('sha256', `draw:${s}`).update('pbcp-draw').digest('base64url');
}

export function verifyDrawKey(given: string | null): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(drawKey());
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DrawRequest {
  source: string;
  svgId: string;
  /** Absent: light. */
  theme?: 'light' | 'dark';
}

/** 200 `{ svg }`; 422 `{ error: 'diagram', message }` when mermaid refused the source; anything else is infrastructure. */
export type DrawResponse = { svg: string } | { error: 'diagram'; message: string };

const DRAW_TIMEOUT_MS = 60_000;

/**
 * Draws `source` (already sanitised) to SVG text. A DiagramError means mermaid refused it; any other error
 * is the drawing infrastructure, which callers must not cache.
 */
export async function drawSvg(source: string, svgId: string, theme: 'light' | 'dark' = 'light'): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-pbcp-draw-key': drawKey() };
  // Vercel's Protection Bypass for Automation, for preview deployments behind Deployment Protection.
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const res = await fetch(drawUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ source, svgId, ...(theme === 'dark' ? { theme } : {}) } satisfies DrawRequest),
    signal: AbortSignal.timeout(DRAW_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as DrawResponse | null;
  if (res.status === 200 && body && 'svg' in body) return body.svg;
  if (res.status === 422 && body && 'error' in body && body.error === 'diagram') throw new DiagramError(body.message);
  throw new Error(`the draw route answered ${res.status}`);
}
