// GET /api/oauth/authorize — the start of the authorization code flow (lib/oauth.ts). A request that passes every check
// goes on to the consent page, signed so it cannot be altered. Every fault found before the owner has consented is a
// 400 page here: nothing is sent to the client's redirect URI until the owner has seen the request and answered.
// POST /api/oauth/authorize { request, allow } — the owner's answer from the consent page, signed in (the owner's own
// session; an assistant's scoped token is refused): where the browser goes next, with a code or access_denied.

import { db } from '../../../../db/client';
import { authenticateSession } from '../../../../lib/auth/session';
import { handle, json, readObject } from '../../../../lib/http';
import { checkAuthorizationRequest, decide, NO_STORE, OAuthError, oauthOrigin, signRequest } from '../../../../lib/oauth';
import { clientAddress, rateLimit } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The refusal, on the head, for the person in the browser; the code for a machine in the `oauth-error` header. */
function refusal(e: OAuthError): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in request refused</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.25rem">This sign-in request cannot be used</h1>
<p>${escape(e.description)}.</p>
<p>Error: <code data-error>${escape(e.error)}</code>. Nothing was sent back to the app; start again from the app.</p>
</body></html>`;
  return new Response(page, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'oauth-error': e.error, ...NO_STORE } });
}

export async function GET(req: Request): Promise<Response> {
  const origin = oauthOrigin();
  const checked = await checkAuthorizationRequest(db(), new URL(req.url).searchParams, origin);
  if ('error' in checked) return refusal(checked.error);
  return Response.redirect(`${origin}/oauth/consent?request=${encodeURIComponent(await signRequest(checked.ok))}`, 302);
}

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    await rateLimit(db(), 'auth', clientAddress(req));
    const session = await authenticateSession(db(), req);
    const body = await readObject(req);
    try {
      return json({ redirect: await decide(db(), session, body.request, body.allow === true, oauthOrigin()) }, 200, NO_STORE);
    } catch (e) {
      if (e instanceof OAuthError) return e.json();
      throw e;
    }
  });
}
