// The human API's writes that are not card operations: the last-visit cursor, producer settings
// (ceilings, revoke), devices, and the head's timezone.

import { URGENCIES, type Urgency } from '@pbcp/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { changeCounter, devices, heads, producerTokens } from '../db/schema';
import { iso, now } from './clock';
import { HttpError } from './http';
import { addDays, isTimeZone, localDate, localMinutes, zonedInstant } from './time';

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

/** Snooze presets, in the head's timezone (mobile PRD gesture model: tonight, tomorrow's brief, next week). */
export const SNOOZE_PRESETS = ['tonight', 'tomorrow', 'next-week'] as const;
const BRIEF_TIME = '05:30';
const EVENING = '18:00';

export async function snoozeUntil(db: Db, headId: string, body: { until?: unknown; preset?: unknown }): Promise<string | null> {
  if (body.preset !== undefined) {
    const [head] = await db.select({ tz: heads.timezone }).from(heads).where(eq(heads.id, headId));
    const tz = head!.tz;
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
  if (typeof body.until !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(body.until) || Number.isNaN(Date.parse(body.until))) {
    throw new HttpError(400, 'invalid_request', 'give until (an RFC 3339 timestamp, or null to unsnooze) or a preset');
  }
  return iso(new Date(body.until));
}

/**
 * PATCH /api/me/producers/{root} { ceiling?, revoked? }: sets the ceiling on every live token of the root
 * (§9: the person sets a per-producer ceiling), or revokes them all (§12: revoking is how to silence a
 * producer). A ceiling applies to cards received from now on; stored cards keep the urgency they were
 * clamped to on receipt.
 *
 * TODO(pbcp-0.4): when 0.4 makes the clamped urgency the head-owned `delivery` field, decide whether a
 * changed ceiling re-clamps open cards (each would then take a new change_seq).
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

/** PATCH /api/me { timezone }: the owner's IANA timezone, which sets the day for the brief, day view and nightly card. */
export async function updateHead(db: Db, headId: string, body: { timezone?: unknown }) {
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || !isTimeZone(body.timezone)) throw new HttpError(400, 'invalid_request', 'timezone must be an IANA zone, e.g. Europe/Copenhagen');
    await db.update(heads).set({ timezone: body.timezone }).where(eq(heads.id, headId));
  }
}
