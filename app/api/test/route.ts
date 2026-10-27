// Test hooks, present only when PBCP_TEST_MODE=1: the head clock, the sync page cap and the rate limits.
// POST { "clock": "<RFC 3339>" | null, "syncPageSize": n | null, "rateLimits": { put?, changes?, auth? } | null }
// — null restores the default.

import { now, setTestClock, testMode } from '../../../lib/clock';
import { json } from '../../../lib/http';
import { limitOverrides, setLimitOverrides, type Bucket } from '../../../lib/rate-limit';
import { setSyncPageSize, syncPageSize } from '../../../lib/settings';

export const dynamic = 'force-dynamic';

const notFound = () => json({ error: 'not_found', message: 'not found' }, 404);

export function GET(): Response {
  if (!testMode()) return notFound();
  return json({ clock: now(), syncPageSize: syncPageSize(), rateLimits: limitOverrides() });
}

export async function POST(req: Request): Promise<Response> {
  if (!testMode()) return notFound();
  const body = (await req.json()) as { clock?: string | null; syncPageSize?: number | null; rateLimits?: Partial<Record<Bucket, number>> | null };
  if (body.clock !== undefined) setTestClock(body.clock ?? undefined);
  if (body.syncPageSize !== undefined) setSyncPageSize(body.syncPageSize ?? undefined);
  if (body.rateLimits !== undefined) setLimitOverrides(body.rateLimits ?? undefined);
  return json({ clock: now(), syncPageSize: syncPageSize(), rateLimits: limitOverrides() });
}
