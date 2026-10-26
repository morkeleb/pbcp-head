// POST /api/me/cards/{id}/ack — the owner acknowledges an artifact or signal (RFC §4.2 acknowledged_at).

import { acknowledgeHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const POST = acknowledgeHandler(4);
