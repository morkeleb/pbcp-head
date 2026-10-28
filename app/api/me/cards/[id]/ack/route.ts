// POST /api/me/cards/{id}/ack — the owner acknowledges an artifact or signal (RFC §4.2 acknowledged_at).

import { acknowledgeHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const POST = acknowledgeHandler(4, { assistant: true });
