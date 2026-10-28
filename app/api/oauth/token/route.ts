// POST /api/oauth/token — the authorization_code (PKCE S256) and refresh_token grants (lib/oauth.ts).

import { db } from '../../../../db/client';
import { preflight, withCors } from '../../../../lib/cors';
import { NO_STORE, OAuthError, token } from '../../../../lib/oauth';
import { clientAddress, rateLimit } from '../../../../lib/rate-limit';
import { headOrigin } from '../../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    await rateLimit(db(), 'auth', clientAddress(req));
    const type = req.headers.get('content-type') ?? '';
    if (!type.startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'the body is application/x-www-form-urlencoded (RFC 6749 §4.1.3)');
    const form = new URLSearchParams(await req.text());
    return withCors(Response.json(await token(db(), form, headOrigin(req.url)), { headers: NO_STORE }));
  } catch (e) {
    if (e instanceof OAuthError) return withCors(e.json());
    if (e instanceof Error && 'status' in e && (e as { status: number }).status === 429) return withCors(Response.json({ error: 'rate_limited' }, { status: 429 }));
    throw e;
  }
}

export const OPTIONS = preflight;
