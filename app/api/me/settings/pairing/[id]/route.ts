// DELETE /api/me/settings/pairing/{id} — cancels an open pairing code.

import { db } from '../../../../../../db/client';
import { rawSegment } from '../../../../../../lib/http';
import { meHandler } from '../../../../../../lib/owner';
import { cancelPairingCode } from '../../../../../../lib/settings/pairing';

export const dynamic = 'force-dynamic';

export const DELETE = meHandler(async (s, req) => {
  await cancelPairingCode(db(), s.headId, rawSegment(req, 5));
  return new Response(null, { status: 204 });
});
