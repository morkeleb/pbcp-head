// POST /api/me/cards/{id}/snooze { until: RFC 3339 UTC | null } or { preset: tonight | tomorrow | next-week }.
// A past or malformed `until` is 400 invalid_snooze (core); `until: null` unsnoozes, as /unsnooze does.

import { snoozeHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const POST = snoozeHandler(4, { assistant: true });
