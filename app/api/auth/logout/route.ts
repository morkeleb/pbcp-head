// POST /api/auth/logout — signs the calling device out (Authorization: Session).

import { db } from '../../../../db/client';
import { authenticateSession, revokeDevice } from '../../../../lib/auth/session';
import { handle } from '../../../../lib/http';
import { limitSignIn } from '../../../../lib/auth/limit';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    await limitSignIn(req);
    await revokeDevice(db(), await authenticateSession(db(), req));
    return new Response(null, { status: 204 });
  });
}
