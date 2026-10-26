// POST /api/auth/passkey/login/options — a challenge for signing in with any registered passkey.

import { loginOptions } from '../../../../../../lib/auth/passkey';
import { handle, json } from '../../../../../../lib/http';

export const dynamic = 'force-dynamic';

export function POST(): Promise<Response> {
  return handle(async () => json(await loginOptions()));
}
