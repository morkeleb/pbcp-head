// Modest per-producer and per-address rate limits (RFC §7.1: `429` with Retry-After, checked after 401
// and before 413). A fixed window counted in Postgres, so every instance of a serverless head shares it;
// rate limiting is not a protocol operation and runs in its own statement, before the operation's
// transaction. Windows run on the wall clock, never the test clock.

import { PbcpError } from '@pbcp/core';
import { lt, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client';
import { rateLimits } from '../db/schema';
import { bearerToken } from './auth/producer';
import { testMode } from './clock';

export interface Limit {
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

/** Per producer token for the producer routes, per client address for sign-in and pairing. */
export const LIMITS = {
  put: { limit: 120, windowSeconds: 60 },
  changes: { limit: 120, windowSeconds: 60 },
  auth: { limit: 30, windowSeconds: 60 },
  // POST /api/pair, per client address: a pairing code is short, so guessing is slow as well as burning every code.
  pair: { limit: 10, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

export type Bucket = keyof typeof LIMITS;

const g = globalThis as unknown as { __pbcpLimits?: Partial<Record<Bucket, number>> };

export function limitFor(bucket: Bucket): Limit {
  const override = testMode() ? g.__pbcpLimits?.[bucket] : undefined;
  return override === undefined ? LIMITS[bucket] : { ...LIMITS[bucket], limit: override };
}

/** Test mode only (/api/test): per-bucket request counts, or undefined for the defaults. */
export function setLimitOverrides(o: Partial<Record<Bucket, number>> | undefined): void {
  if (!testMode()) throw new Error('only available in test mode');
  g.__pbcpLimits = o;
}

export const limitOverrides = () => g.__pbcpLimits ?? null;

/** The key for a producer route: the presented token's hash, so the count is per token. */
export function producerKey(req: Request): string {
  return createHash('sha256').update(bearerToken(req) ?? '').digest('hex');
}

/**
 * The client's address. On Vercel the platform sets X-Forwarded-For and X-Real-IP itself; a self-hosted head
 * must sit behind a proxy that does the same (docs/deploy.md), or every client shares one key.
 */
export function clientAddress(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** Counts one request against `bucket` for `key`; over the limit, 429 `rate_limited` with Retry-After. */
export async function rateLimit(db: Db, bucket: Bucket, key: string): Promise<void> {
  const { limit, windowSeconds } = limitFor(bucket);
  const nowMs = Date.now();
  const start = Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000;
  const [row] = await db
    .insert(rateLimits)
    .values({ bucket, key, windowStart: new Date(start), count: 1, expiresAt: new Date(start + windowSeconds * 1000) })
    .onConflictDoUpdate({ target: [rateLimits.bucket, rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  // The first request of a window sweeps every window that has ended.
  if (row!.count === 1) await db.delete(rateLimits).where(lt(rateLimits.expiresAt, new Date(nowMs)));
  if (row!.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((start + windowSeconds * 1000 - nowMs) / 1000));
    throw new PbcpError('rate_limited', `at most ${limit} requests per ${windowSeconds} s`, { retryAfter });
  }
}
