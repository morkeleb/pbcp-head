// POST /api/oauth/register — dynamic client registration (RFC 7591), public clients only (lib/oauth.ts). The body is read
// with the same size limit as every other route.

import { db } from '../../../../db/client';
import { preflight, withCors } from '../../../../lib/cors';
import { readBody } from '../../../../lib/http';
import { NO_STORE, OAuthError, registerClient } from '../../../../lib/oauth';
import { clientAddress, rateLimit } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    await rateLimit(db(), 'auth', clientAddress(req));
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof Error && 'status' in e && (e as { status: number }).status === 413) throw new OAuthError('invalid_client_metadata', 'the registration is too large', 413);
      throw new OAuthError('invalid_client_metadata', 'the body must be a JSON object');
    }
    return withCors(Response.json(await registerClient(db(), body), { status: 201, headers: NO_STORE }));
  } catch (e) {
    if (e instanceof OAuthError) return withCors(e.json());
    if (e instanceof Error && 'status' in e && (e as { status: number }).status === 429) {
      return withCors(Response.json({ error: 'rate_limited', error_description: 'too many registrations from this address' }, { status: 429, headers: { 'retry-after': String((e as { retryAfter?: number }).retryAfter ?? 60), ...NO_STORE } }));
    }
    throw e;
  }
}

export const OPTIONS = preflight;
