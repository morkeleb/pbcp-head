// GET /api/push/key — public: the head's VAPID public key, which a device's service worker subscribes with (lib/push).
// 503 push_unavailable when the head has no VAPID keys. It is a public key: nothing here is a secret.

import { handle, HttpError, json } from '../../../../lib/http';
import { vapidPublicKey } from '../../../../lib/push/send';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return handle(async () => {
    const key = vapidPublicKey();
    if (!key) throw new HttpError(503, 'push_unavailable', 'this head has no VAPID keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)');
    return json({ public_key: key });
  });
}
