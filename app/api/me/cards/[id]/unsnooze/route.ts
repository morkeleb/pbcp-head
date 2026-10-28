// POST /api/me/cards/{id}/unsnooze — clears snoozed_until (§4.2). Same as snooze with { until: null }.

import { unsnoozeHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const POST = unsnoozeHandler(4, { assistant: true });
