// POST /api/auth/passkey/step-up/options — a challenge for the signed-in person to identify themselves again with one of
// the head's passkeys (RFC 0.9 §4.1 `confirm`, §4.5 "Identifying again"). The owner's own session only: an assistant's
// scoped token is refused, so an assistant can never satisfy a `confirm` card.

import { db } from '../../../../../../db/client';
import { stepUpOptions } from '../../../../../../lib/auth/passkey';
import { authenticateSession } from '../../../../../../lib/auth/session';
import { limitSignIn } from '../../../../../../lib/auth/limit';
import { handle, json } from '../../../../../../lib/http';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const session = await authenticateSession(db(), req);
    await limitSignIn(req);
    return json(await stepUpOptions(db(), session));
  });
}
