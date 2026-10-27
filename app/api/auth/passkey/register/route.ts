// POST /api/auth/passkey/register { state, response, platform?, name? } — stores the passkey, signs the device in.

import { db } from '../../../../../db/client';
import { register } from '../../../../../lib/auth/passkey';
import { handle, json, readObject } from '../../../../../lib/http';
import { limitSignIn } from '../../../../../lib/auth/limit';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    await limitSignIn(req);
    return json(await register(db(), await readObject(req)));
  });
}
