// POST /api/me/settings/push — stores this device's Web Push subscription ({ endpoint, keys: { p256dh, auth } }, as
// PushSubscription.toJSON() gives it) on its devices row, replacing any it had; DELETE removes it (lib/push/send.ts).
// Always the calling device's: a subscription is made by the device's own service worker.

import { db } from '../../../../../db/client';
import { readObject } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { clearSubscription, subscribe } from '../../../../../lib/push/send';

export const dynamic = 'force-dynamic';

export const POST = meHandler(async (s, req) => {
  await subscribe(db(), s.deviceId, await readObject(req), req.headers.get('user-agent'));
  return new Response(null, { status: 204 });
});

export const DELETE = meHandler(async (s) => {
  await clearSubscription(db(), s.deviceId);
  return new Response(null, { status: 204 });
});
