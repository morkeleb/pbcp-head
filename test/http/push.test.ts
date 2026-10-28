// The daily brief notification (lib/push): subscribing and unsubscribing a device, its setting, and the cron's sends,
// received by a stand-in push service on localhost that the test decrypts as a browser would (RFC 8291).

import ece from 'http_ece';
import { createECDH, randomBytes, type ECDH } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cronRuns, devices } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { TEST_CRON_SECRET, TEST_VAPID_PUBLIC_KEY } from '../env';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';

// --- the stand-in push service ---------------------------------------------------------------------------------

interface Received { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }
let service: Server;
let port = 0;
let received: Received[] = [];
/** The status the service answers per subscription path (201 otherwise). */
const answer = new Map<string, number>();

beforeAll(async () => {
  service = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer.get(req.url!) ?? 201).end();
    });
  });
  await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
  port = (service.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => service.close(() => r())));

/** A browser's subscription: its own key pair and auth secret, so the test can read what was sent to it. */
function browserSubscription(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    path: `/push/${name}`,
    json: { endpoint: `http://127.0.0.1:${port}/push/${name}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

const decrypt = (r: Received, sub: { ecdh: ECDH; auth: Buffer }) =>
  JSON.parse(ece.decrypt(r.body, { version: 'aes128gcm', privateKey: sub.ecdh, authSecret: sub.auth }).toString('utf8'));

// --- the head --------------------------------------------------------------------------------------------------

let hermes: string;
const clock = (at: string) => call('POST', '/api/test', { body: { clock: at } });
const cron = async () => (await call('GET', '/api/cron/brief', { auth: `Bearer ${TEST_CRON_SECRET}` })).body as { notified: Array<{ device: string; date: string; result: string }> };

/** A web device in Copenhagen, subscribed, with the daily notification on at `time`. */
async function device(name: string, opts: { time?: string; subscribe?: boolean; enable?: boolean } = {}) {
  const d = await ownerSession(OWNER, name);
  await call('GET', '/api/me/brief', { auth: d.auth, headers: { 'x-timezone': 'Europe/Copenhagen' } });
  const sub = browserSubscription(name);
  if (opts.subscribe !== false) expect((await call('POST', '/api/me/settings/push', { auth: d.auth, body: sub.json })).status).toBe(204);
  const r = await call('PATCH', `/api/me/settings/devices/${d.deviceId}`, { auth: d.auth, body: { daily_notification: { enabled: opts.enable !== false, time: opts.time ?? '07:00' } } });
  expect(r.status).toBe(200);
  return { ...d, sub };
}

beforeEach(async () => {
  await resetHead();
  received = [];
  answer.clear();
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
});

describe('subscribing', () => {
  it('serves the public key, stores and removes a subscription on the calling device, and refuses a malformed one', async () => {
    expect((await call('GET', '/api/push/key')).body).toEqual({ public_key: TEST_VAPID_PUBLIC_KEY });
    const d = await ownerSession(OWNER, 'laptop');
    const sub = browserSubscription('laptop');
    const mine = async () => (await call('GET', '/api/me/settings/devices', { auth: d.auth })).body.devices.find((x: { id: string }) => x.id === d.deviceId);
    expect((await mine()).daily_notification).toEqual({ enabled: false, time: '07:00', subscribed: false });

    expect((await call('POST', '/api/me/settings/push', { auth: d.auth, body: sub.json, headers: { 'user-agent': 'TestBrowser/1' } })).status).toBe(204);
    expect((await mine()).daily_notification.subscribed).toBe(true);
    const [row] = await testDb().select().from(devices).where(eq(devices.id, d.deviceId));
    expect(row).toMatchObject({ pushEndpoint: sub.json.endpoint, pushP256dh: sub.json.keys.p256dh, pushAuth: sub.json.keys.auth, pushUserAgent: 'TestBrowser/1' });
    expect(row!.pushSubscribedAt).toBeInstanceOf(Date);

    expect((await call('DELETE', '/api/me/settings/push', { auth: d.auth })).status).toBe(204);
    expect((await mine()).daily_notification.subscribed).toBe(false);

    for (const bad of [{}, { endpoint: 'ftp://x.example/1', keys: sub.json.keys }, { endpoint: sub.json.endpoint, keys: { p256dh: 'short', auth: sub.json.keys.auth } }]) {
      const r = await call('POST', '/api/me/settings/push', { auth: d.auth, body: bad });
      expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
    }
    expect((await call('POST', '/api/me/settings/push', { auth: hermes, body: sub.json })).status).toBe(401);
  });

  it('sets the time on a quarter hour, only from the device itself', async () => {
    const a = await ownerSession(OWNER, 'laptop');
    const b = await ownerSession(OWNER, 'phone');
    const patch = (who: typeof a, id: string, n: unknown) => call('PATCH', `/api/me/settings/devices/${id}`, { auth: who.auth, body: { daily_notification: n } });
    let r = await patch(a, a.deviceId, { enabled: true, time: '06:45' });
    expect(r.body.daily_notification).toEqual({ enabled: true, time: '06:45', subscribed: false });
    r = await patch(a, a.deviceId, { time: '07:10' });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
    r = await patch(a, a.deviceId, { enabled: 'yes' });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
    r = await patch(a, b.deviceId, { enabled: true });
    expect([r.status, r.body.error]).toEqual([403, 'not_this_device']);
    r = await patch(a, 'nope', { enabled: true });
    expect([r.status, r.body.error]).toEqual([404, 'not_found']);
    // The other device sees it, as it is.
    const seen = (await call('GET', '/api/me/settings/devices', { auth: b.auth })).body.devices.find((x: { id: string }) => x.id === a.deviceId);
    expect(seen.daily_notification).toEqual({ enabled: true, time: '06:45', subscribed: false });
  });
});

describe('the cron sends the daily notification', () => {
  it('once to a device whose time has passed, never again that day, and not to one switched off or without a subscription', async () => {
    await clock('2026-10-07T04:40:00Z'); // 06:40 in Copenhagen
    const on = await device('on');
    await device('off', { enable: false });
    await device('unsubscribed', { subscribe: false });
    expect((await cron()).notified).toEqual([]);

    await clock('2026-10-07T05:00:00Z'); // 07:00
    expect((await cron()).notified).toEqual([{ device: on.deviceId, date: '2026-10-07', result: 'sent' }]);
    expect(received.map((r) => r.path)).toEqual([on.sub.path]);
    expect(received[0]!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: expect.any(String), authorization: expect.stringMatching(/^vapid t=.+, k=/) });
    expect(decrypt(received[0]!, on.sub)).toEqual({ title: 'Brief', body: 'Nothing waiting', data: { url: '/brief' }, tag: 'pbcp-daily' });

    // The same run again, a later one the same day, and a run that went back over the time: nothing more.
    expect((await cron()).notified).toEqual([]);
    await clock('2026-10-07T05:15:00Z');
    expect((await cron()).notified).toEqual([]);
    await testDb().delete(cronRuns);
    await clock('2026-10-07T05:05:00Z');
    expect((await cron()).notified).toEqual([]);
    expect(received).toHaveLength(1);

    // The next day, once more.
    await clock('2026-10-08T05:00:00Z');
    expect((await cron()).notified).toEqual([{ device: on.deviceId, date: '2026-10-08', result: 'sent' }]);
  });

  it('does not send at once when turned on after its time: the first comes the next day', async () => {
    await clock('2026-10-07T06:00:00Z'); // 08:00
    await cron();
    await device('late', { time: '07:00' });
    await clock('2026-10-07T06:15:00Z');
    expect((await cron()).notified).toEqual([]);
  });

  it('quotes the daily paragraph’s first sentence once the card exists, and counts the decisions before', async () => {
    // Received a minute apart, so the paragraph's order (newest first) is fixed.
    for (const n of [1, 2]) {
      await clock(`2026-10-07T02:0${n}:00Z`); // 04:0n
      await call('PUT', cardPath(`hermes:mail:${n}`), { auth: hermes, body: card(`hermes:mail:${n}`, { title: `Reply to Anna ${n}`, summary: `About the invoice, part ${n}.` }) });
    }
    const early = await device('early', { time: '05:00' });
    const later = await device('later', { time: '07:00' });

    await clock('2026-10-07T03:00:00Z'); // 05:00: before the card (05:30)
    await cron();
    expect(decrypt(received.find((r) => r.path === early.sub.path)!, early.sub).body).toBe('2 decisions waiting');

    await clock('2026-10-07T03:30:00Z'); // 05:30: the card
    await cron();
    await clock('2026-10-07T05:00:00Z'); // 07:00
    await cron();
    const body = decrypt(received.find((r) => r.path === later.sub.path)!, later.sub).body as string;
    expect(body).toBe('2 decisions: Reply to Anna 2 — About the invoice, part 2; Reply to Anna 1 — About the invoice, part 1.');
  });

  it('removes a subscription the push service says is gone (410), and sends to it no more', async () => {
    await clock('2026-10-07T04:50:00Z');
    const gone = await device('gone');
    answer.set(gone.sub.path, 410);
    await clock('2026-10-07T05:00:00Z');
    expect((await cron()).notified).toEqual([{ device: gone.deviceId, date: '2026-10-07', result: 'gone' }]);
    const [row] = await testDb().select().from(devices).where(eq(devices.id, gone.deviceId));
    expect(row).toMatchObject({ pushEndpoint: null, pushP256dh: null, pushAuth: null, notifyDaily: true });
    const shown = (await call('GET', '/api/me/settings/devices', { auth: gone.auth })).body.devices.find((x: { id: string }) => x.id === gone.deviceId);
    expect(shown.daily_notification).toEqual({ enabled: true, time: '07:00', subscribed: false });
    await clock('2026-10-08T05:00:00Z');
    expect((await cron()).notified).toEqual([]);
    expect(received).toHaveLength(1);
  });
});
