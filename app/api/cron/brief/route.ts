// GET /api/cron/brief — Vercel Cron, every 15 minutes (vercel.json; a Pro plan; docs/deploy.md for Hobby). Mints
// each head's nightly card once it is 05:30 or later in the head's effective timezone (lib/brief/nightly.ts), then sends
// each device whose chosen time came since the last run its daily notification (lib/push/daily.ts). Authenticated by
// CRON_SECRET, which Vercel sends as a bearer token; it is neither a producer token nor a session, and
// nothing else is accepted here.

import { timingSafeEqual } from 'node:crypto';
import { db } from '../../../../db/client';
import { runNightly } from '../../../../lib/brief/nightly';
import { runDailyNotifications } from '../../../../lib/push/daily';
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
    // The card first, so a notification at the same time can quote its paragraph.
    const minted = await runNightly(db());
    return json({ minted, notified: await runDailyNotifications(db()) });
  });
}
