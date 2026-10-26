// POST /api/me/cards/{id}/seen — the head presented the card to its owner (RFC §4.2 seen_at).

import { seenHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const POST = seenHandler(4);
