// DELETE /api/me/settings/invites/{id} — removes one invite request (lib/invites.ts).

import { db } from '../../../../../../db/client';
import { rawSegment } from '../../../../../../lib/http';
import { deleteInvite } from '../../../../../../lib/invites';
import { meHandler } from '../../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const DELETE = meHandler(async (s, req) => {
  await deleteInvite(db(), s.headId, rawSegment(req, 5));
  return new Response(null, { status: 204 });
});
