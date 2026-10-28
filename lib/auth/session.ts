// Human sessions (mobile PRD, "Auth"): a 15-minute access JWT and a 90-day refresh token, one per device,
// stored hashed and rotated on every use. `/api/me/` accepts only `Authorization: Session <jwt>`; producer
// tokens never authenticate here, and session tokens never authenticate a producer route.

import { and, eq, isNull } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import { devices } from '../../db/schema';
import { now } from '../clock';
import { HttpError } from '../http';
import { canonicalZone, TIMEZONE_HEADER } from '../timezone';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60;
const ISSUER = 'pbcp-head';

export const PLATFORMS = ['web', 'ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];
/** An assistant connected through OAuth (lib/oauth.ts); never a platform a sign-in can claim. */
export const MCP_PLATFORM = 'mcp';

export interface Session {
  headId: string;
  deviceId: string;
}

/** What every sign-in and refresh returns. */
export interface SessionTokens {
  token_type: 'Session';
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: string;
  device_id: string;
  head: string;
}

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(s);
}

/** A short-lived signed token for one purpose (access, enrolment, a WebAuthn challenge). */
export async function sign(audience: string, claims: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(`${ISSUER}:${audience}`)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret());
}

/** Verifies a token made by `sign` for `audience`; null when it is invalid, expired or for another purpose. */
export async function verify(audience: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: `${ISSUER}:${audience}`, algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

export const hash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
export const newRefreshToken = () => `pbcp_rt_${randomBytes(32).toString('base64url')}`;

async function issue(headId: string, deviceId: string, refreshToken: string, refreshExpiresAt: Date): Promise<SessionTokens> {
  return {
    token_type: 'Session',
    access_token: await sign('session', { sub: headId, did: deviceId }, ACCESS_TTL_SECONDS),
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    refresh_expires_at: refreshExpiresAt.toISOString(),
    device_id: deviceId,
    head: headId,
  };
}

export interface NewDevice {
  headId: string;
  identityId: string | null;
  platform?: unknown;
  name?: unknown;
}

/** Signs a device in: a devices row with a fresh refresh token, and the session tokens for it. */
export async function startSession(db: Db, d: NewDevice): Promise<SessionTokens> {
  const platform = (PLATFORMS as readonly unknown[]).includes(d.platform) ? (d.platform as Platform) : 'web';
  const name = typeof d.name === 'string' && d.name.length > 0 ? d.name.slice(0, 100) : null;
  const id = randomUUID();
  const refresh = newRefreshToken();
  const expires = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  await db.insert(devices).values({
    id, headId: d.headId, identityId: d.identityId, platform, name,
    refreshTokenHash: hash(refresh), refreshExpiresAt: expires, lastSeenAt: new Date(),
  });
  return issue(d.headId, id, refresh, expires);
}

/**
 * Rotates a refresh token: the device gets a new one and the old one is retired. Presenting a token that was already
 * rotated out means it leaked, so the device is revoked and must sign in again. `accepts` decides whether this kind of
 * refresh is for this device (a web session's, or an assistant's through OAuth); a device it refuses is left as it is.
 * Null when the token is not valid, has expired, or its device was signed out or refused.
 */
export async function rotateRefresh(
  db: Db,
  refreshToken: string,
  accepts: (device: typeof devices.$inferSelect) => boolean,
): Promise<{ device: typeof devices.$inferSelect; next: string; expires: Date } | null> {
  const h = hash(refreshToken);
  // The refusal is the caller's, after the transaction, so revoking a device on reuse commits rather than rolls back.
  return db.transaction(async (tx) => {
    const [device] = await tx.select().from(devices).where(eq(devices.refreshTokenHash, h)).for('update');
    if (!device) {
      const [reused] = await tx.select().from(devices).where(eq(devices.previousRefreshHash, h)).for('update');
      if (reused && reused.revokedAt === null) {
        await tx.update(devices).set({ revokedAt: new Date(), refreshTokenHash: null }).where(eq(devices.id, reused.id));
      }
      return null;
    }
    if (device.revokedAt !== null || device.refreshExpiresAt === null || device.refreshExpiresAt <= new Date() || !accepts(device)) return null;
    const next = newRefreshToken();
    const expires = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
    await tx
      .update(devices)
      .set({ refreshTokenHash: hash(next), previousRefreshHash: h, refreshExpiresAt: expires, lastSeenAt: new Date() })
      .where(eq(devices.id, device.id));
    return { device, next, expires };
  });
}

/**
 * Exchanges a refresh token for a new pair and retires it (rotateRefresh). An assistant's device (platform `mcp`)
 * refreshes through OAuth only (lib/oauth.ts), never here.
 */
export async function refreshSession(db: Db, refreshToken: unknown): Promise<SessionTokens> {
  if (typeof refreshToken !== 'string' || refreshToken === '') throw new HttpError(400, 'invalid_request', 'refresh_token is required');
  const rotated = await rotateRefresh(db, refreshToken, (d) => d.platform !== MCP_PLATFORM);
  if (!rotated) throw new HttpError(401, 'unauthorized', 'the refresh token is not valid, has expired, or its device was signed out');
  return issue(rotated.device.headId, rotated.device.id, rotated.next, rotated.expires);
}

/** Signs a device out: its refresh token stops working and its access tokens are refused from now on. */
export async function revokeDevice(db: Db, s: Session): Promise<void> {
  await db
    .update(devices)
    .set({ revokedAt: new Date(), refreshTokenHash: null })
    .where(and(eq(devices.id, s.deviceId), eq(devices.headId, s.headId)));
}

/** The `Session` credential from a request, or null. A `Bearer` (producer) token is never a session. */
export function sessionToken(req: Request): string | null {
  const m = /^Session +(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

/**
 * `Authorization: Session <jwt>`: a valid access token for a device that is still signed in. Anything else,
 * a producer's `Bearer` token included, is 401 `unauthorized`.
 *
 * Any /api/me request may also carry `X-Timezone: <IANA zone>`, the zone the device is in now. It is checked
 * after the credential (an unknown zone is 400 `invalid_request`) and stored on the device with `tz_seen_at`;
 * the head follows the zone of the device most recently seen (lib/timezone.ts).
 */
export async function authenticateSession(db: Db, req: Request): Promise<Session> {
  const token = sessionToken(req);
  if (token === null) throw new HttpError(401, 'unauthorized', 'a session is required: Authorization: Session <access token>');
  const claims = await verify('session', token);
  if (!claims || typeof claims.sub !== 'string' || typeof claims.did !== 'string') {
    throw new HttpError(401, 'unauthorized', 'the session is not valid or has expired');
  }
  const live = and(eq(devices.id, claims.did), eq(devices.headId, claims.sub), isNull(devices.revokedAt));
  const header = req.headers.get(TIMEZONE_HEADER);
  const [device] =
    header === null
      ? await db.select({ id: devices.id }).from(devices).where(live)
      : await db
          .update(devices)
          .set({ timezone: canonicalZone(header, 'X-Timezone'), tzSeenAt: new Date(now()) })
          .where(live)
          .returning({ id: devices.id });
  if (!device) throw new HttpError(401, 'unauthorized', 'this device has been signed out');
  return { headId: claims.sub, deviceId: claims.did };
}
