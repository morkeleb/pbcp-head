// PATCH /api/me/settings/devices/{id} { daily_notification?: { enabled?, time? }, urgent_notification?: { enabled } } —
// this device's notifications: the daily brief (lib/push/daily.ts), on or off at a quarter hour (HH:MM) in its timezone,
// and urgent cards (lib/push/urgent.ts). Only the device itself may change them (403 not_this_device), as only it can
// subscribe. DELETE /api/me/settings/devices/{id} — signs that device out.

import { db } from '../../../../../../db/client';
import { decodeId, json, rawSegment, readObject } from '../../../../../../lib/http';
import { meHandler } from '../../../../../../lib/owner';
import { deleteDevice, setNotifications } from '../../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const PATCH = meHandler(async (s, req) => json(await setNotifications(db(), s, decodeId(rawSegment(req, 5)), await readObject(req))));

export const DELETE = meHandler(async (s, req) => {
  await deleteDevice(db(), s.headId, decodeId(rawSegment(req, 5)));
  return new Response(null, { status: 204 });
});
