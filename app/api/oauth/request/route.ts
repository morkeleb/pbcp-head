// GET /api/oauth/request?request=<signed request> — what the consent page shows, once the head has verified the request
// it signed (lib/oauth.ts): the client's name and the host it returns to. The owner's own session only.

import { db } from '../../../../db/client';
import { authenticateSession } from '../../../../lib/auth/session';
import { handle, HttpError, json } from '../../../../lib/http';
import { NO_STORE, requestInfo } from '../../../../lib/oauth';

export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    await authenticateSession(db(), req);
    const info = await requestInfo(new URL(req.url).searchParams.get('request'));
    if (!info) throw new HttpError(400, 'invalid_request', 'this sign-in request has expired or was altered; start again from the app');
    return json(info, 200, NO_STORE);
  });
}
