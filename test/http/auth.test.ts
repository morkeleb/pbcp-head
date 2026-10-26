import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devices, identities } from '../../db/schema';
import { enrollmentToken } from '../../lib/auth/enroll';
import { mintProducerToken } from '../../lib/auth/producer';
import { TEST_APPLE_CLIENT_ID, TEST_APPLE_PORT, TEST_SESSION_SECRET } from '../env';
import { call, headUrl, OWNER, resetHead, testDb } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

process.env.SESSION_SECRET = TEST_SESSION_SECRET;

beforeEach(() => resetHead());

async function registerPasskey(auth = new SoftAuthenticator(headUrl())) {
  const enroll = await enrollmentToken(OWNER);
  const opts = await call('POST', '/api/auth/passkey/register/options', { body: { enroll } });
  expect(opts.status).toBe(200);
  const r = await call('POST', '/api/auth/passkey/register', {
    body: { state: opts.body.state, response: auth.create(opts.body.options), platform: 'ios', name: 'Test phone' },
  });
  return { auth, r };
}

async function signIn(auth: SoftAuthenticator) {
  const opts = await call('POST', '/api/auth/passkey/login/options', { body: {} });
  return call('POST', '/api/auth/passkey/login', { body: { state: opts.body.state, response: auth.get(opts.body.options), platform: 'web' } });
}

const session = (t: { access_token: string }) => `Session ${t.access_token}`;

describe('passkeys, end to end', () => {
  it('registers a passkey from an enrolment token and signs the device in', async () => {
    const { auth, r } = await registerPasskey();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token_type: 'Session', expires_in: 900, head: OWNER, device_id: expect.any(String) });
    const [identity] = await testDb().select().from(identities);
    expect(identity).toMatchObject({ headId: OWNER, provider: 'passkey', subject: auth.id });
    const [device] = await testDb().select().from(devices);
    expect(device).toMatchObject({ id: r.body.device_id, platform: 'ios', name: 'Test phone', identityId: identity!.id });
    expect(device!.refreshTokenHash).not.toBeNull();
  });

  it('signs in with the registered passkey, advancing its signature counter', async () => {
    const { auth } = await registerPasskey();
    const r = await signIn(auth);
    expect(r.status).toBe(200);
    expect(r.body.head).toBe(OWNER);
    expect((await signIn(auth)).status).toBe(200);
    const [identity] = await testDb().select().from(identities);
    expect((identity!.credential as { counter: number }).counter).toBe(2);
  });

  it('refuses an unknown passkey, and registration without a session or enrolment token', async () => {
    expect((await signIn(new SoftAuthenticator(headUrl()))).status).toBe(401);
    expect((await call('POST', '/api/auth/passkey/register/options', { body: {} })).status).toBe(401);
    const forged = await enrollmentToken('someone-else');
    expect((await call('POST', '/api/auth/passkey/register/options', { body: { enroll: forged } })).status).toBe(401);
  });

  it('refuses an assertion for a challenge the head did not issue', async () => {
    const { auth } = await registerPasskey();
    const opts = await call('POST', '/api/auth/passkey/login/options', { body: {} });
    const response = auth.get({ ...opts.body.options, challenge: Buffer.from('replayed').toString('base64url') });
    expect((await call('POST', '/api/auth/passkey/login', { body: { state: opts.body.state, response } })).status).toBe(401);
  });

  it('lets a signed-in owner add a second passkey with the session alone', async () => {
    const { r } = await registerPasskey();
    const opts = await call('POST', '/api/auth/passkey/register/options', { auth: session(r.body), body: {} });
    expect(opts.status).toBe(200);
    const second = new SoftAuthenticator(headUrl());
    const r2 = await call('POST', '/api/auth/passkey/register', { body: { state: opts.body.state, response: second.create(opts.body.options) } });
    expect(r2.status).toBe(200);
    expect(await testDb().select().from(identities)).toHaveLength(2);
  });
});

describe('sessions', () => {
  it('rotates the refresh token on use; the retired token revokes the device if presented again', async () => {
    const { r } = await registerPasskey();
    const first = r.body;
    const refreshed = await call('POST', '/api/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token);
    expect(refreshed.body.device_id).toBe(first.device_id);

    const reuse = await call('POST', '/api/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(reuse.status).toBe(401);
    const [device] = await testDb().select().from(devices).where(eq(devices.id, first.device_id));
    expect(device!.revokedAt).not.toBeNull();
    expect((await call('POST', '/api/auth/refresh', { body: { refresh_token: refreshed.body.refresh_token } })).status).toBe(401);
    expect((await call('POST', '/api/auth/logout', { auth: session(refreshed.body) })).status).toBe(401);
  });

  it('logout signs only that device out', async () => {
    const { auth, r } = await registerPasskey();
    const other = (await signIn(auth)).body;
    expect((await call('POST', '/api/auth/logout', { auth: session(r.body) })).status).toBe(204);
    expect((await call('POST', '/api/auth/refresh', { body: { refresh_token: r.body.refresh_token } })).status).toBe(401);
    expect((await call('POST', '/api/auth/refresh', { body: { refresh_token: other.refresh_token } })).status).toBe(200);
  });

  it('never accepts a producer token where a session is required', async () => {
    const token = await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' });
    for (const auth of [`Bearer ${token}`, `Session ${token}`, 'Session not-a-jwt']) {
      expect(await call('POST', '/api/auth/logout', { auth })).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    }
  });
});

describe('Sign in with Apple', () => {
  let apple: Server;
  let key: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
    apple = createServer((_, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
    await new Promise<void>((ok) => apple.listen(TEST_APPLE_PORT, ok));
  });
  afterAll(() => new Promise<void>((ok) => apple.close(() => ok())));

  const idToken = (sub: string, aud = TEST_APPLE_CLIENT_ID) =>
    new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://appleid.apple.com')
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);

  it('links an Apple subject with an enrolment token, then signs it in without one', async () => {
    const enroll = await enrollmentToken(OWNER);
    expect((await call('POST', '/api/auth/apple', { body: { id_token: await idToken('001.apple') } })).status).toBe(401);
    const linked = await call('POST', '/api/auth/apple', { body: { id_token: await idToken('001.apple'), enroll, platform: 'ios' } });
    expect(linked).toMatchObject({ status: 200, body: { head: OWNER, token_type: 'Session' } });
    const [identity] = await testDb().select().from(identities);
    expect(identity).toMatchObject({ provider: 'apple', subject: '001.apple', headId: OWNER });
    expect((await call('POST', '/api/auth/apple', { body: { id_token: await idToken('001.apple') } })).status).toBe(200);
  });

  it('refuses a token for another audience', async () => {
    const enroll = await enrollmentToken(OWNER);
    const r = await call('POST', '/api/auth/apple', { body: { id_token: await idToken('001.apple', 'someone.else'), enroll } });
    expect(r.status).toBe(401);
  });
});
