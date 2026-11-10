// POST /api/auth/passkey/step-up { state, response } — verifies the assertion and stamps the calling session as
// re-identified for the next REAUTH_WINDOW_SECONDS (lib/sensitivity.ts), without rotating any token. A `confirm` card's
// decision is recorded only within that window (lib/protocol.ts decideCard).

import { db } from '../../../../../db/client';
import { stepUp } from '../../../../../lib/auth/passkey';
import { authenticateSession } from '../../../../../lib/auth/session';
import { limitSignIn } from '../../../../../lib/auth/limit';
import { handle, json, readObject } from '../../../../../lib/http';
import { REAUTH_WINDOW_SECONDS } from '../../../../../lib/sensitivity';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const session = await authenticateSession(db(), req);
    await limitSignIn(req);
    return json({ ...(await stepUp(db(), session, await readObject(req))), window_seconds: REAUTH_WINDOW_SECONDS });
  });
}
