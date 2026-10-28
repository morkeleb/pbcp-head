// POST /api/me/cards/{id}/seen — the head presented the card to its owner (RFC §4.2 seen_at).

import { seenHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const POST = seenHandler(4, { assistant: true });
