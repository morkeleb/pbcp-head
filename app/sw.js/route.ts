// GET /sw.js — the service worker (lib/pwa/service-worker.ts). Served from the root so its scope is the whole
// app; its bytes carry the build id, so each deployment installs a new worker and drops the old app shell.

import { serviceWorkerSource } from '../../lib/pwa/service-worker';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(serviceWorkerSource(process.env.PBCP_BUILD_ID ?? 'dev'), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // The browser checks for a new worker on navigation; never let an HTTP cache answer for it.
      'cache-control': 'no-cache',
      // A worker's own policy: it fetches from this origin only and runs no other script.
      'content-security-policy': "default-src 'self'; script-src 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}
