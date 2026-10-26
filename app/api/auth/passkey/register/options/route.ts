// POST /api/auth/passkey/register/options { enroll? } — options for adding a passkey to the caller's head,
// which needs a session or an enrolment token.

import { db } from '../../../../../../db/client';
import { enrollingHead } from '../../../../../../lib/auth/enroll';
import { registrationOptions } from '../../../../../../lib/auth/passkey';
import { handle, json, readObject } from '../../../../../../lib/http';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readObject(req);
    return json(await registrationOptions(db(), await enrollingHead(db(), req, body.enroll)));
  });
}
