// DELETE /api/me/settings/devices/{id} — signs that device out.

import { db } from '../../../../../../db/client';
import { decodeId, rawSegment } from '../../../../../../lib/http';
import { meHandler } from '../../../../../../lib/owner';
import { deleteDevice } from '../../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const DELETE = meHandler(async (s, req) => {
  await deleteDevice(db(), s.headId, decodeId(rawSegment(req, 5)));
  return new Response(null, { status: 204 });
});
