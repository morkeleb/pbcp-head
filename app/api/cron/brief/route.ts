// GET /api/cron/brief — Vercel Cron, hourly at :30 (vercel.json; a Pro plan; docs/deploy.md for Hobby). Mints
// each head's nightly card once it is 05:30 or later in the head's effective timezone (lib/brief/nightly.ts). Authenticated by
// CRON_SECRET, which Vercel sends as a bearer token; it is neither a producer token nor a session, and
// nothing else is accepted here.

import { timingSafeEqual } from 'node:crypto';
import { db } from '../../../../db/client';
import { runNightly } from '../../../../lib/brief/nightly';
import { handle, HttpError, json } from '../../../../lib/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    if (!authorised(req)) throw new HttpError(401, 'unauthorized', 'cron only');
    return json({ minted: await runNightly(db()) });
  });
}
