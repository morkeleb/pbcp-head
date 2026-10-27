// GET /api/me — who is signed in: the head, its display name, this device, the effective timezone and the
// last visit. The head's settings are at /api/me/settings.

import { db } from '../../../db/client';
import { iso } from '../../../lib/clock';
import { json } from '../../../lib/http';
import { headSettings } from '../../../lib/me';
import { meHandler } from '../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => {
  const head = await headSettings(db(), s.headId);
  return json({
    head: head.id,
    display_name: head.displayName,
    device_id: s.deviceId,
    timezone: head.timezone,
    last_visit: { seq: head.lastVisitSeq, at: head.lastVisitAt ? iso(head.lastVisitAt) : null },
  });
});
