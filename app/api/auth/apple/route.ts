// POST /api/auth/apple { id_token, enroll?, platform?, name? } — Sign in with Apple; 501 when not configured.

import { db } from '../../../../db/client';
import { appleSignIn } from '../../../../lib/auth/apple';
import { handle, json, readObject } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => json(await appleSignIn(db(), req, await readObject(req))));
}
