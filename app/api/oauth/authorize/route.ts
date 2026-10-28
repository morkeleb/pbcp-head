// GET /api/oauth/authorize — the start of the authorization code flow (lib/oauth.ts). A request from a registered client
// to one of its registered redirect URIs goes on to the consent page, signed so it cannot be altered; any other is
// refused here, and nothing is redirected to an address the head cannot vouch for.
// POST /api/oauth/authorize { request, allow } — the owner's answer from the consent page, signed in (a Session): where
// the browser goes next, with a code or access_denied.

import { db } from '../../../../db/client';
import { authenticateSession } from '../../../../lib/auth/session';
import { handle, json, readObject } from '../../../../lib/http';
import { checkAuthorizationRequest, decide, NO_STORE, OAuthError, signRequest } from '../../../../lib/oauth';
import { clientAddress, rateLimit } from '../../../../lib/rate-limit';
import { headOrigin } from '../../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const origin = headOrigin(req.url);
  const checked = await checkAuthorizationRequest(db(), new URL(req.url).searchParams, origin);
  if ('error' in checked) {
    if (checked.redirect) return Response.redirect(checked.redirect, 302);
    return new Response(`This sign-in request cannot be used: ${checked.error.description}.`, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE } });
  }
  return Response.redirect(`${origin}/oauth/consent?request=${encodeURIComponent(await signRequest(checked.ok))}`, 302);
}

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    await rateLimit(db(), 'auth', clientAddress(req));
    const session = await authenticateSession(db(), req);
    const body = await readObject(req);
    try {
      return json({ redirect: await decide(db(), session, body.request, body.allow === true, headOrigin(req.url)) }, 200, NO_STORE);
    } catch (e) {
      if (e instanceof OAuthError) return e.json();
      throw e;
    }
  });
}
