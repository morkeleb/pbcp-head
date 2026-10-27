// POST /api/me/cards/{id}/unsnooze — clears snoozed_until (§4.2). Same as snooze with { until: null }.

import { unsnoozeHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const POST = unsnoozeHandler(4);
