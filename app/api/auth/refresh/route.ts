// POST /api/auth/refresh { refresh_token } — a new access token and a new refresh token; the old one is retired.

import { db } from '../../../../db/client';
import { refreshSession } from '../../../../lib/auth/session';
import { handle, json, readObject } from '../../../../lib/http';
import { limitSignIn } from '../../../../lib/auth/limit';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    await limitSignIn(req);
    return json(await refreshSession(db(), (await readObject(req)).refresh_token));
  });
}
