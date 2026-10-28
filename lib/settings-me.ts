// The human API's writes that are not card operations: the last-visit cursor, producer settings
// (ceilings, revoke), devices, and the head's settings (display name, timezone override).

import { isLabel, URGENCIES, type Urgency } from '@pbcp/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cards, changeCounter, devices, heads, labelCeilings, producerTokens } from '../db/schema';
import { iso, now } from './clock';
import { HttpError } from './http';
import { addDays, localDate, localMinutes, zonedInstant } from './time';
import { SNOOZE_PRESETS } from './api/schemas';
import { canonicalZone, effectiveTimezone } from './timezone';
import { listDevices } from './me';
import { parseQuarterHour } from './push/daily';

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

/**
 * GET /api/me/settings/labels: every label on the head's cards (§4.1), with how many cards carry it and the ceiling the owner
 * set on it, if any (§9: a head MAY set ceilings per label), by label.
 */
export async function listLabels(db: Db, headId: string) {
  const used = await db.execute<{ label: string; cards: number }>(
    sql`select l as label, count(*)::int as cards from ${cards}, jsonb_array_elements_text(coalesce(${cards.producerDoc}->'labels', '[]'::jsonb)) as l where ${cards.headId} = ${headId} group by l`,
  );
  const set = await db.select().from(labelCeilings).where(eq(labelCeilings.headId, headId));
  const ceilings = new Map(set.map((r) => [r.label, r.ceiling as Urgency]));
  const names = [...new Set([...used.map((u) => u.label), ...ceilings.keys()])].sort();
  const counts = new Map(used.map((u) => [u.label, u.cards]));
  return names.map((label) => ({ label, cards: counts.get(label) ?? 0, ceiling: ceilings.get(label) ?? null }));
}

/**
 * PATCH /api/me/settings/labels/{label} { ceiling: log | brief | immediate | null }: sets or clears the owner's ceiling on a
 * label (§9). A card under a producer ceiling and label ceilings is stored with the lowest; like a producer ceiling it
 * applies to content stored from now on.
 */
export async function setLabelCeiling(db: Db, headId: string, label: string, ceiling: Urgency | null) {
  if (!isLabel(label)) throw new HttpError(400, 'invalid_request', 'a label is 1 to 32 lowercase letters, digits or - (§4.1)');
  if (ceiling === null) await db.delete(labelCeilings).where(and(eq(labelCeilings.headId, headId), eq(labelCeilings.label, label)));
  else await db.insert(labelCeilings).values({ headId, label, ceiling }).onConflictDoUpdate({ target: [labelCeilings.headId, labelCeilings.label], set: { ceiling } });
  return (await listLabels(db, headId)).find((l) => l.label === label) ?? { label, cards: 0, ceiling };
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

/**
 * PATCH /api/me/settings/devices/{id}: the daily brief notification of the calling device. `time` is HH:MM on a quarter
 * hour in the device's timezone. Another device's is refused: it subscribes for itself, so it is set from there.
 */
export async function setDailyNotification(db: Db, s: { headId: string; deviceId: string }, id: string, body: { daily_notification?: unknown }) {
  const n = body.daily_notification as { enabled?: unknown; time?: unknown } | undefined;
  if (!n || typeof n !== 'object' || (n.enabled === undefined && n.time === undefined)) throw new HttpError(400, 'invalid_request', 'expected { daily_notification: { enabled?, time? } }');
  if (n.enabled !== undefined && typeof n.enabled !== 'boolean') throw new HttpError(400, 'invalid_request', 'enabled is true or false');
  const minutes = n.time === undefined ? undefined : parseQuarterHour(n.time);
  if (minutes === null) throw new HttpError(400, 'invalid_request', 'time is HH:MM on a quarter hour, e.g. 07:00 or 21:45');
  const [device] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.headId, s.headId), eq(devices.id, id), isNull(devices.revokedAt)));
  if (!device) throw new HttpError(404, 'not_found', `no signed-in device ${id}`);
  if (id !== s.deviceId) throw new HttpError(403, 'not_this_device', 'a device’s notification is set on that device, which subscribes for it');
  await db
    .update(devices)
    .set({ ...(n.enabled !== undefined ? { notifyDaily: n.enabled as boolean } : {}), ...(minutes !== undefined ? { notifyAtMinutes: minutes } : {}) })
    .where(eq(devices.id, id));
  return (await listDevices(db, s.headId, s.deviceId)).find((d) => d.id === id)!;
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
