// POST /api/me/cards/{id}/decision — the owner decides (RFC §7.3); actor = the signed-in device.

import { decisionHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const POST = decisionHandler(4);
