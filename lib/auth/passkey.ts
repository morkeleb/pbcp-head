// Passkeys (WebAuthn) for the web head and Android (mobile PRD, Auth decision 1). The relying party is
// WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN. Challenges travel in a short-lived signed `state` token rather than a
// table: the client gets it with the options and sends it back with the authenticator's response.

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import { identities } from '../../db/schema';
import { HttpError } from '../http';
import { markReauthenticated, sign, startSession, verify, type Session, type SessionTokens } from './session';

const STATE_TTL_SECONDS = 5 * 60;

interface StoredPasskey {
  publicKey: string; // base64url COSE key
  counter: number;
  transports?: string[];
}

function relyingParty() {
  const origin = process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000';
  return { rpID: process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname, origin, rpName: process.env.WEBAUTHN_RP_NAME ?? 'head' };
}

async function readState(state: unknown, purpose: 'register' | 'login' | 'step-up'): Promise<{ challenge: string; head?: string }> {
  const claims = typeof state === 'string' ? await verify(`webauthn-${purpose}`, state) : null;
  if (!claims || typeof claims.challenge !== 'string') throw new HttpError(400, 'invalid_request', 'state is missing, invalid or expired; ask for new options');
  return { challenge: claims.challenge, ...(typeof claims.sub === 'string' ? { head: claims.sub } : {}) };
}

/** Options for creating a passkey on `headId`, which the caller has already proved it owns. */
export async function registrationOptions(db: Db, headId: string) {
  const { rpID, rpName } = relyingParty();
  const existing = await db.select().from(identities).where(and(eq(identities.headId, headId), eq(identities.provider, 'passkey')));
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: headId,
    userID: new TextEncoder().encode(headId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: existing.map((i) => ({ id: i.subject })),
  });
  return { options, state: await sign('webauthn-register', { sub: headId, challenge: options.challenge }, STATE_TTL_SECONDS) };
}

/** Verifies the new passkey, stores it as an identity of the head, and signs the device in. */
export async function register(db: Db, body: { state?: unknown; response?: unknown; platform?: unknown; name?: unknown }): Promise<SessionTokens> {
  const { challenge, head } = await readState(body.state, 'register');
  const { rpID, origin } = relyingParty();
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    throw new HttpError(400, 'invalid_credential', `the passkey could not be verified: ${(e as Error).message}`);
  }
  if (!verified.verified || !head) throw new HttpError(400, 'invalid_credential', 'the passkey could not be verified');
  const { credential } = verified.registrationInfo;
  const identityId = randomUUID();
  const stored: StoredPasskey = {
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    ...(credential.transports ? { transports: credential.transports } : {}),
  };
  const inserted = await db
    .insert(identities)
    .values({ id: identityId, headId: head, provider: 'passkey', subject: credential.id, credential: stored, lastUsedAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: identities.id });
  if (inserted.length === 0) throw new HttpError(409, 'already_registered', 'this passkey is already registered');
  return startSession(db, { headId: head, identityId, platform: body.platform, name: body.name, identified: true });
}

/** Options for signing in with any passkey of this relying party (discoverable credentials). */
export async function loginOptions() {
  const options = await generateAuthenticationOptions({ rpID: relyingParty().rpID, userVerification: 'preferred' });
  return { options, state: await sign('webauthn-login', { challenge: options.challenge }, STATE_TTL_SECONDS) };
}

/** Verifies an assertion against the stored passkey, advances its counter, and signs the device in. */
export async function login(db: Db, body: { state?: unknown; response?: unknown; platform?: unknown; name?: unknown }): Promise<SessionTokens> {
  const { challenge } = await readState(body.state, 'login');
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!response || typeof response.id !== 'string') throw new HttpError(400, 'invalid_request', 'response is required');
  const [identity] = await db.select().from(identities).where(and(eq(identities.provider, 'passkey'), eq(identities.subject, response.id)));
  if (!identity) throw new HttpError(401, 'unauthorized', 'this passkey is not registered with this head');
  const stored = identity.credential as StoredPasskey;
  const { rpID, origin } = relyingParty();
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: identity.subject,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        ...(stored.transports ? { transports: stored.transports } : {}),
      },
    });
  } catch (e) {
    throw new HttpError(401, 'unauthorized', `the passkey could not be verified: ${(e as Error).message}`);
  }
  if (!verified.verified) throw new HttpError(401, 'unauthorized', 'the passkey could not be verified');
  await db
    .update(identities)
    .set({ credential: { ...stored, counter: verified.authenticationInfo.newCounter }, lastUsedAt: new Date() })
    .where(eq(identities.id, identity.id));
  return startSession(db, { headId: identity.headId, identityId: identity.id, platform: body.platform, name: body.name, identified: true });
}

// --- step-up (RFC 0.9 §4.1 `confirm`, §4.5 "Identifying again") ---------------------------------------------------------

/**
 * Options for the person to identify themselves again on the session they are signed in with: an assertion with one of
 * the head's own passkeys, user verification required. The state is bound to the session's device.
 */
export async function stepUpOptions(db: Db, s: Session) {
  const keys = await db.select().from(identities).where(and(eq(identities.headId, s.headId), eq(identities.provider, 'passkey')));
  if (keys.length === 0) throw new HttpError(409, 'no_passkey', 'this head has no passkey to identify yourself with; add one in Settings → Devices');
  const options = await generateAuthenticationOptions({
    rpID: relyingParty().rpID,
    userVerification: 'required',
    allowCredentials: keys.map((k) => ({ id: k.subject, ...((k.credential as StoredPasskey).transports ? { transports: (k.credential as StoredPasskey).transports as never } : {}) })),
  });
  return { options, state: await sign('webauthn-step-up', { sub: s.headId, did: s.deviceId, challenge: options.challenge }, STATE_TTL_SECONDS) };
}

/**
 * Verifies the step-up assertion and stamps the session as re-identified (`devices.reauthenticated_at`), without rotating
 * any token. The passkey must be one of the session's own head, and the state one issued to this device.
 */
export async function stepUp(db: Db, s: Session, body: { state?: unknown; response?: unknown }): Promise<{ reauthenticated_at: string }> {
  const claims = typeof body.state === 'string' ? await verify('webauthn-step-up', body.state) : null;
  if (!claims || typeof claims.challenge !== 'string' || claims.sub !== s.headId || claims.did !== s.deviceId) {
    throw new HttpError(400, 'invalid_request', 'state is missing, invalid, expired or for another session; ask for new options');
  }
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!response || typeof response.id !== 'string') throw new HttpError(400, 'invalid_request', 'response is required');
  const [identity] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.provider, 'passkey'), eq(identities.subject, response.id), eq(identities.headId, s.headId)));
  if (!identity) throw new HttpError(401, 'unauthorized', 'this passkey is not one of this head’s');
  const stored = identity.credential as StoredPasskey;
  const { rpID, origin } = relyingParty();
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claims.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: identity.subject,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        ...(stored.transports ? { transports: stored.transports as never } : {}),
      },
    });
  } catch (e) {
    throw new HttpError(401, 'unauthorized', `the passkey could not be verified: ${(e as Error).message}`);
  }
  if (!verified.verified) throw new HttpError(401, 'unauthorized', 'the passkey could not be verified');
  await db
    .update(identities)
    .set({ credential: { ...stored, counter: verified.authenticationInfo.newCounter }, lastUsedAt: new Date() })
    .where(eq(identities.id, identity.id));
  return { reauthenticated_at: (await markReauthenticated(db, s)).toISOString() };
}
