// POST /api/oauth/register — dynamic client registration (RFC 7591), public clients only (lib/oauth.ts).

import { db } from '../../../../db/client';
import { preflight, withCors } from '../../../../lib/cors';
import { NO_STORE, OAuthError, registerClient } from '../../../../lib/oauth';
import { clientAddress, rateLimit } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    await rateLimit(db(), 'auth', clientAddress(req));
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new OAuthError('invalid_client_metadata', 'the body must be a JSON object');
    }
    return withCors(Response.json(await registerClient(db(), body), { status: 201, headers: NO_STORE }));
  } catch (e) {
    if (e instanceof OAuthError) return withCors(e.json());
    if (e instanceof Error && 'status' in e && (e as { status: number }).status === 429) return withCors(Response.json({ error: 'rate_limited' }, { status: 429 }));
    throw e;
  }
}

export const OPTIONS = preflight;
