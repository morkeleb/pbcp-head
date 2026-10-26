// POST /api/me/cards/{id}/snooze { until: RFC 3339 | null } or { preset: tonight | tomorrow | next-week }.

import { snoozeHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const POST = snoozeHandler(4);
