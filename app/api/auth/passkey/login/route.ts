// POST /api/auth/passkey/login { state, response, platform?, name? } — verifies the assertion, signs the device in.

import { db } from '../../../../../db/client';
import { login } from '../../../../../lib/auth/passkey';
import { handle, json, readObject } from '../../../../../lib/http';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => json(await login(db(), await readObject(req))));
}
