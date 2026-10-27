// The head's effective timezone: the owner's day for the brief and its timeline, snooze presets and the nightly
// card. Not a protocol concern (the RFC's timestamps are UTC); the head decides which calendar its owner lives on.
//
//   1. heads.timezone, when the owner set it (PATCH /api/me/settings): an explicit choice wins.
//   2. Otherwise the zone of the device most recently seen: every /api/me request may carry X-Timezone, and
//      the session middleware stores it on that device with tz_seen_at (lib/auth/session.ts). The owner's
//      active device is where they are, so the head follows them when they travel.
//   3. Otherwise UTC: no device has said yet.

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { devices, heads } from '../db/schema';
import { HttpError } from './http';
import { isTimeZone } from './time';

export const DEFAULT_TIMEZONE = 'UTC';
export const TIMEZONE_HEADER = 'x-timezone';

export interface EffectiveTimezone {
  /** The zone the head uses now. */
  timezone: string;
  /** Where it comes from. */
  source: 'override' | 'device' | 'default';
  /** The owner's explicit zone, or null when the head follows its devices. */
  override: string | null;
  /** The device most recently seen with a zone, whether or not the override wins over it. */
  device: { id: string; timezone: string; seen_at: Date } | null;
}

export async function effectiveTimezone(db: Db, headId: string, override?: string | null): Promise<EffectiveTimezone> {
  if (override === undefined) {
    const [head] = await db.select({ tz: heads.timezone }).from(heads).where(eq(heads.id, headId));
    override = head?.tz ?? null;
  }
  const [device] = await db
    .select({ id: devices.id, timezone: devices.timezone, seenAt: devices.tzSeenAt })
    .from(devices)
    .where(and(eq(devices.headId, headId), isNull(devices.revokedAt), isNotNull(devices.timezone), isNotNull(devices.tzSeenAt)))
    .orderBy(desc(devices.tzSeenAt))
    .limit(1);
  const seen = device ? { id: device.id, timezone: device.timezone!, seen_at: device.seenAt! } : null;
  if (override) return { timezone: override, source: 'override', override, device: seen };
  if (seen) return { timezone: seen.timezone, source: 'device', override: null, device: seen };
  return { timezone: DEFAULT_TIMEZONE, source: 'default', override: null, device: null };
}

/** An IANA zone in its canonical spelling (`europe/copenhagen` → `Europe/Copenhagen`), or a 400. */
export function canonicalZone(value: unknown, what: string): string {
  // Intl also takes a bare offset (`+02:00`), which is not a zone: it has no daylight saving time.
  if (typeof value !== 'string' || !/^[A-Za-z]/.test(value) || !isTimeZone(value)) {
    throw new HttpError(400, 'invalid_request', `${what} must be an IANA timezone, e.g. Europe/Copenhagen`);
  }
  return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
}
