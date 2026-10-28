// PATCH /api/me/settings/devices/{id} { daily_notification: { enabled?, time? } } — this device's daily brief
// notification (lib/push/daily.ts): on or off, at a quarter hour (HH:MM) in its timezone. Only the device itself may
// change it (403 not_this_device), as only it can subscribe. DELETE /api/me/settings/devices/{id} — signs that device out.

import { db } from '../../../../../../db/client';
import { decodeId, json, rawSegment, readObject } from '../../../../../../lib/http';
import { meHandler } from '../../../../../../lib/owner';
import { deleteDevice, setDailyNotification } from '../../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const PATCH = meHandler(async (s, req) => json(await setDailyNotification(db(), s, decodeId(rawSegment(req, 5)), await readObject(req))));

export const DELETE = meHandler(async (s, req) => {
  await deleteDevice(db(), s.headId, decodeId(rawSegment(req, 5)));
  return new Response(null, { status: 204 });
});
