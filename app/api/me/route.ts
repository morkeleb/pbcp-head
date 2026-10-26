// GET /api/me — who is signed in: the head, this device, the head's timezone and last visit.
// PATCH /api/me { timezone } — the owner's IANA timezone.

import { db } from '../../../db/client';
import { iso } from '../../../lib/clock';
import { json, readObject } from '../../../lib/http';
import { headSettings } from '../../../lib/me';
import { meHandler } from '../../../lib/owner';
import { updateHead } from '../../../lib/settings-me';

export const dynamic = 'force-dynamic';

const me = async (headId: string, deviceId: string) => {
  const head = await headSettings(db(), headId);
  return { head: head.id, device_id: deviceId, timezone: head.timezone, last_visit: { seq: head.lastVisitSeq, at: head.lastVisitAt ? iso(head.lastVisitAt) : null } };
};

export const GET = meHandler(async (s) => json(await me(s.headId, s.deviceId)));

export const PATCH = meHandler(async (s, req) => {
  await updateHead(db(), s.headId, await readObject(req));
  return json(await me(s.headId, s.deviceId));
});
