// Web Push for the web app (RFC 8030, 8291 and 8292 VAPID): a device's service worker subscribes, the subscription is
// kept on its devices row, and the head sends to it. One send function for every notification: the daily brief now
// (lib/push/daily.ts); immediate-urgency cards later go through `sendPush` the same way.
//
// web-push builds the request (payload encryption and the VAPID JWT); it is sent with fetch, so a subscription whose
// push service answers 404 or 410 (gone: unsubscribed, expired, the app removed) is removed here, from its device row.
// Keys: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (`npx web-push generate-vapid-keys`); the subject is VAPID_SUBJECT,
// else WEBAUTHN_ORIGIN when it is https, else a mailto: placeholder for a local head. Never logged: endpoints, keys.

import { and, eq } from 'drizzle-orm';
import webpush from 'web-push';
import type { Db } from '../../db/client';
import { devices } from '../../db/schema';
import { HttpError } from '../http';

export interface PushPayload {
  title: string;
  body: string;
  /** What the service worker opens on a tap, and a tag so a newer notification of the same kind replaces the older. */
  data: { url: string };
  tag?: string;
}

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type SendResult = 'sent' | 'gone' | 'failed';

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

function vapid(): { subject: string; publicKey: string; privateKey: string } {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) throw new HttpError(503, 'push_unavailable', 'this head has no VAPID keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)');
  const origin = process.env.WEBAUTHN_ORIGIN ?? '';
  const subject = process.env.VAPID_SUBJECT || (origin.startsWith('https://') ? origin : 'mailto:head@localhost.invalid');
  return { subject, publicKey, privateKey };
}

/** A subscription as the browser gives it (PushSubscription.toJSON()), checked: an https endpoint and both keys. */
export function parseSubscription(body: unknown): Subscription {
  const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const bad = () => new HttpError(400, 'invalid_request', 'expected a push subscription: { endpoint, keys: { p256dh, auth } }');
  if (typeof b.endpoint !== 'string' || b.endpoint.length > 2048 || typeof b.keys?.p256dh !== 'string' || typeof b.keys.auth !== 'string') throw bad();
  let url: URL;
  try {
    url = new URL(b.endpoint);
  } catch {
    throw bad();
  }
  // A push service is https; plain http only in test mode, where the tests run one on localhost.
  if (url.protocol !== 'https:' && !(process.env.PBCP_TEST_MODE === '1' && url.protocol === 'http:')) throw bad();
  if (!/^[A-Za-z0-9_-]{20,200}={0,2}$/.test(b.keys.p256dh) || !/^[A-Za-z0-9_-]{8,100}={0,2}$/.test(b.keys.auth)) throw bad();
  return { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } };
}

/**
 * Sends one notification to a device's subscription. `gone`: the push service no longer knows it (404, 410), and it is
 * removed from the device so it is not tried again; `failed`: anything else (the next notification tries again).
 */
export async function sendPush(db: Db, device: { id: string; pushEndpoint: string | null; pushP256dh: string | null; pushAuth: string | null }, payload: PushPayload): Promise<SendResult> {
  if (!device.pushEndpoint || !device.pushP256dh || !device.pushAuth) return 'failed';
  const subscription = { endpoint: device.pushEndpoint, keys: { p256dh: device.pushP256dh, auth: device.pushAuth } };
  const details = webpush.generateRequestDetails(subscription, JSON.stringify(payload), { vapidDetails: vapid(), TTL: 4 * 60 * 60, urgency: 'normal', ...(payload.tag ? { topic: payload.tag } : {}) });
  // fetch sets Content-Length itself and refuses one given.
  const headers = Object.fromEntries(Object.entries(details.headers).filter(([k]) => k.toLowerCase() !== 'content-length').map(([k, v]) => [k, String(v)]));
  let status: number;
  try {
    const res = await fetch(details.endpoint, { method: details.method, headers, body: details.body ? new Uint8Array(details.body) : null, signal: AbortSignal.timeout(10_000) });
    status = res.status;
    await res.body?.cancel();
  } catch {
    return 'failed';
  }
  if (status === 404 || status === 410) {
    await clearSubscription(db, device.id, device.pushEndpoint);
    return 'gone';
  }
  return status >= 200 && status < 300 ? 'sent' : 'failed';
}

const NO_SUBSCRIPTION = { pushEndpoint: null, pushP256dh: null, pushAuth: null, pushSubscribedAt: null, pushUserAgent: null };

/** Removes a device's subscription; with `endpoint`, only if it is still that one (a newer one made meanwhile stays). */
export async function clearSubscription(db: Db, deviceId: string, endpoint?: string): Promise<void> {
  await db.update(devices).set(NO_SUBSCRIPTION).where(endpoint ? and(eq(devices.id, deviceId), eq(devices.pushEndpoint, endpoint)) : eq(devices.id, deviceId));
}

/** POST /api/me/settings/push: stores the subscription on the calling device, replacing any it had. */
export async function subscribe(db: Db, deviceId: string, body: unknown, userAgent: string | null): Promise<void> {
  const s = parseSubscription(body);
  await db
    .update(devices)
    .set({ pushEndpoint: s.endpoint, pushP256dh: s.keys.p256dh, pushAuth: s.keys.auth, pushSubscribedAt: new Date(), pushUserAgent: userAgent?.slice(0, 300) ?? null })
    .where(eq(devices.id, deviceId));
}
