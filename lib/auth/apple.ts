// Sign in with Apple (mobile PRD, Auth decision 1). The client — the iOS app natively, the web through
// Apple's JS in popup mode — obtains an identity token and posts it here; the head verifies it against
// Apple's keys. Configured by APPLE_CLIENT_ID (the Services ID and/or bundle id, comma-separated); without
// it the route answers 501 not_configured. APPLE_JWKS_URL exists so tests can stand in for Apple.
//
// Not yet: the authorization-code exchange (which needs the team id and a signed client secret). The
// identity token alone is enough to establish who signed in, which is all the head needs.

import { and, eq } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import { identities } from '../../db/schema';
import { HttpError } from '../http';
import { enrollingHead } from './enroll';
import { startSession, type SessionTokens } from './session';

const APPLE_ISSUER = 'https://appleid.apple.com';
const g = globalThis as unknown as { __pbcpAppleJwks?: ReturnType<typeof createRemoteJWKSet> };

export const appleConfigured = (): boolean => Boolean(process.env.APPLE_CLIENT_ID);

async function appleSubject(idToken: unknown): Promise<string> {
  if (typeof idToken !== 'string' || idToken === '') throw new HttpError(400, 'invalid_request', 'id_token is required');
  g.__pbcpAppleJwks ??= createRemoteJWKSet(new URL(process.env.APPLE_JWKS_URL ?? `${APPLE_ISSUER}/auth/keys`));
  try {
    const { payload } = await jwtVerify(idToken, g.__pbcpAppleJwks, {
      issuer: APPLE_ISSUER,
      audience: process.env.APPLE_CLIENT_ID!.split(',').map((s) => s.trim()),
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new Error('no subject');
    return payload.sub;
  } catch (e) {
    throw new HttpError(401, 'unauthorized', `the Apple identity token could not be verified: ${(e as Error).message}`);
  }
}

/**
 * Signs in with an Apple identity token. A known subject signs in to its head; an unknown one is linked to
 * a head only with a session or an enrolment token (`enroll`), never created on its own.
 */
export async function appleSignIn(
  db: Db,
  req: Request,
  body: { id_token?: unknown; enroll?: unknown; platform?: unknown; name?: unknown },
): Promise<SessionTokens> {
  if (!appleConfigured()) throw new HttpError(501, 'not_configured', 'Sign in with Apple is not configured on this head (APPLE_CLIENT_ID)');
  const subject = await appleSubject(body.id_token);
  let [identity] = await db.select().from(identities).where(and(eq(identities.provider, 'apple'), eq(identities.subject, subject)));
  if (!identity) {
    const headId = await enrollingHead(db, req, body.enroll);
    [identity] = await db
      .insert(identities)
      .values({ id: randomUUID(), headId, provider: 'apple', subject })
      .returning();
  }
  await db.update(identities).set({ lastUsedAt: new Date() }).where(eq(identities.id, identity!.id));
  return startSession(db, { headId: identity!.headId, identityId: identity!.id, platform: body.platform, name: body.name });
}
