// The human API's writes that are not card operations: the last-visit cursor, producer settings
// (ceilings, revoke), devices, and the head's settings (display name, timezone override).

import { URGENCIES, type Urgency } from '@pbcp/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { changeCounter, devices, heads, producerTokens } from '../db/schema';
import { iso, now } from './clock';
import { HttpError } from './http';
import { addDays, localDate, localMinutes, zonedInstant } from './time';
import { SNOOZE_PRESETS } from './api/schemas';
import { canonicalZone, effectiveTimezone } from './timezone';

/**
 * POST /api/me/visit: the owner left the brief having seen everything up to `seq` (default: now). The
 * cursor is global per head (RFC §14 leaves per-producer cursors open) and only moves forward.
 */
export async function visit(db: Db, headId: string, seq: unknown) {
  if (seq !== undefined && seq !== null && !(Number.isSafeInteger(seq) && (seq as number) >= 0)) {
    throw new HttpError(400, 'invalid_request', 'seq must be a change_seq');
  }
  const [counter] = await db.select({ seq: changeCounter.seq }).from(changeCounter).where(eq(changeCounter.headId, headId));
  if (!counter) throw new HttpError(404, 'not_found', 'no such head');
  const current = counter.seq;
  const target = seq === undefined || seq === null ? current : Math.min(seq as number, current);
  const [row] = await db
    .update(heads)
    .set({ lastVisitSeq: sql`greatest(${heads.lastVisitSeq}, ${target})`, lastVisitAt: new Date(now()) })
    .where(eq(heads.id, headId))
    .returning({ seq: heads.lastVisitSeq, at: heads.lastVisitAt });
  if (!row) throw new HttpError(404, 'not_found', 'no such head');
  return { seq: row!.seq, at: iso(row!.at!) };
}

const BRIEF_TIME = '05:30';
const EVENING = '18:00';

export async function snoozeUntil(db: Db, headId: string, body: { until?: unknown; preset?: unknown }): Promise<string | null> {
  if (body.preset !== undefined) {
    const { timezone: tz } = await effectiveTimezone(db, headId);
    const at = new Date(now());
    const today = localDate(at, tz);
    switch (body.preset) {
      case 'tonight':
        // Past 18:00 already: the next evening.
        return iso(zonedInstant(localMinutes(at, tz) < 18 * 60 ? today : addDays(today, 1), EVENING, tz));
      case 'tomorrow':
        return iso(zonedInstant(addDays(today, 1), BRIEF_TIME, tz));
      case 'next-week':
        return iso(zonedInstant(addDays(today, 7), BRIEF_TIME, tz));
      default:
        throw new HttpError(400, 'invalid_request', `preset must be one of ${SNOOZE_PRESETS.join(', ')}`);
    }
  }
  if (body.until === null) return null;
  // Checked by core's snooze: anything but a UTC timestamp later than now is 400 invalid_snooze.
  return body.until as string;
}

/**
 * PATCH /api/me/producers/{root} { ceiling?, revoked? }: sets the ceiling on every live token of the root
 * (§9: the person sets a per-producer ceiling), or revokes them all (§12: revoking is how to silence a
 * producer). A ceiling applies to content stored from now on: §9 says changing a ceiling does not
 * revisit stored cards, so their `delivery` stays as it was clamped.
 */
export async function updateProducer(db: Db, headId: string, root: string, body: { ceiling?: unknown; revoked?: unknown }) {
  const live = and(eq(producerTokens.headId, headId), eq(producerTokens.root, root), isNull(producerTokens.revokedAt));
  const exists = await db.select({ root: producerTokens.root }).from(producerTokens).where(and(eq(producerTokens.headId, headId), eq(producerTokens.root, root))).limit(1);
  if (exists.length === 0) throw new HttpError(404, 'not_found', `no producer ${root}`);
  if (body.ceiling !== undefined) {
    if (!(URGENCIES as readonly unknown[]).includes(body.ceiling)) throw new HttpError(400, 'invalid_request', `ceiling must be one of ${URGENCIES.join(', ')}`);
    await db.update(producerTokens).set({ urgencyCeiling: body.ceiling as Urgency }).where(live);
  }
  if (body.revoked !== undefined) {
    if (body.revoked !== true) throw new HttpError(400, 'invalid_request', 'revoked can only be set to true; mint a new token to bring a producer back');
    await db.update(producerTokens).set({ revokedAt: new Date() }).where(live);
  }
}

/** DELETE /api/me/devices/{id}: signs that device out (its refresh token and access tokens stop working). */
export async function deleteDevice(db: Db, headId: string, id: string): Promise<void> {
  const r = await db
    .update(devices)
    .set({ revokedAt: new Date(), refreshTokenHash: null })
    .where(and(eq(devices.headId, headId), eq(devices.id, id), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  if (r.length === 0) throw new HttpError(404, 'not_found', `no signed-in device ${id}`);
}

export const DISPLAY_NAME_MAX = 100;

/**
 * GET /api/me/settings: the head's settings. `head` is the stable id producers address (`to_person`);
 * `display_name` is only for showing. `timezone` is the effective zone, `timezone_override` the owner's explicit
 * one (null: follow the devices), `timezone_source` which of the two (or the UTC default) is in force, and
 * `device_timezone` the most recent zone a device sent.
 */
export async function settings(db: Db, headId: string) {
  const [head] = await db.select().from(heads).where(eq(heads.id, headId));
  if (!head) throw new HttpError(404, 'not_found', 'no such head');
  const zone = await effectiveTimezone(db, headId, head.timezone);
  return {
    head: head.id,
    display_name: head.displayName,
    timezone: zone.timezone,
    timezone_source: zone.source,
    timezone_override: zone.override,
    device_timezone: zone.device ? { device_id: zone.device.id, timezone: zone.device.timezone, seen_at: iso(zone.device.seen_at) } : null,
  };
}

/**
 * PATCH /api/me/settings { timezone?: zone | null, display_name?: string | null }. A zone sets the override,
 * which wins over the devices; null clears it, and the head follows the device most recently seen again.
 */
export async function updateSettings(db: Db, headId: string, body: { timezone?: unknown; display_name?: unknown }) {
  const set: { timezone?: string | null; displayName?: string | null } = {};
  if (body.timezone !== undefined) set.timezone = body.timezone === null ? null : canonicalZone(body.timezone, 'timezone');
  if (body.display_name !== undefined) {
    const name = body.display_name;
    if (name !== null && (typeof name !== 'string' || name.trim() === '' || name.length > DISPLAY_NAME_MAX || /[\r\n]/.test(name))) {
      throw new HttpError(400, 'invalid_request', `display_name must be one line of 1 to ${DISPLAY_NAME_MAX} characters, or null`);
    }
    set.displayName = name === null ? null : name.trim();
  }
  if (Object.keys(set).length > 0) await db.update(heads).set(set).where(eq(heads.id, headId));
  return settings(db, headId);
}
