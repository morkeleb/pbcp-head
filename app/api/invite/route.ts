// POST /api/invite { email } — public: the front door's "Request an invite" form (lib/invites.ts). No credential is
// needed, and none is accepted: a request carrying an Authorization header (a session, a producer token) is refused,
// as on /api/pair. Rate-limited per address. The form also posts here without JavaScript (form-encoded): that request
// is sent back to the front door with `?invite=requested`.

import { db } from '../../../db/client';
import { HttpError, handle, json, readBody } from '../../../lib/http';
import { requestInvite } from '../../../lib/invites';
import { clientAddress, rateLimit } from '../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    await rateLimit(db(), 'invite', clientAddress(req));
    if (req.headers.get('authorization') !== null) {
      throw new HttpError(400, 'invalid_request', 'an invite request takes no credential');
    }
    const form = (req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
    const raw = await readBody(req);
    let body: { email?: unknown };
    if (form) body = { email: new URLSearchParams(raw).get('email') ?? '' };
    else {
      try {
        body = JSON.parse(raw) as { email?: unknown };
      } catch {
        throw new HttpError(400, 'malformed_json', 'expected { "email": "…" }');
      }
    }
    await requestInvite(db(), body ?? {}, req.headers.get('user-agent'));
    if (form) return new Response(null, { status: 303, headers: { location: '/?invite=requested#invite' } });
    return json({ requested: true }, 202);
  });
}
