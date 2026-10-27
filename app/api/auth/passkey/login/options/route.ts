// POST /api/auth/passkey/login/options — a challenge for signing in with any registered passkey.

import { loginOptions } from '../../../../../../lib/auth/passkey';
import { handle, json } from '../../../../../../lib/http';
import { limitSignIn } from '../../../../../../lib/auth/limit';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    await limitSignIn(req);
    return json(await loginOptions());
  });
}
