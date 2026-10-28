// POST /api/me/cards/{id}/decision — the owner decides (RFC §7.3); actor = the signed-in device.

import { decisionHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const POST = decisionHandler(4, { assistant: true });
