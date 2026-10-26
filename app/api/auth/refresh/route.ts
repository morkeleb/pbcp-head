// POST /api/auth/refresh { refresh_token } — a new access token and a new refresh token; the old one is retired.

import { db } from '../../../../db/client';
import { refreshSession } from '../../../../lib/auth/session';
import { handle, json, readObject } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => json(await refreshSession(db(), (await readObject(req)).refresh_token)));
}
