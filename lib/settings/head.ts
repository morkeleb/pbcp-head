// What a producer needs to know about this head (RFC §7.5): the describe document's facts, and the URL it is given. The
// producer routes live under /api (PUT /api/cards/{id}, GET /api/changes, and GET /api/ describes the head), so a
// producer's head URL is the origin plus /api (docs/deploy.md).

import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { changeCounter } from '../../db/schema';
import { describeHead } from '../describe';

/** The head's public origin (WEBAUTHN_ORIGIN, else the request's). */
export function headOrigin(fallback?: string): string {
  const configured = process.env.WEBAUTHN_ORIGIN;
  try {
    if (configured) return new URL(configured).origin;
  } catch {
    // fall through
  }
  return fallback ? new URL(fallback).origin : 'http://localhost:3000';
}

/** The head URL a producer is given: the origin plus /api. */
export const producerUrl = (origin: string) => `${origin}/api`;

export async function headFacts(db: Db, headId: string, url: string) {
  const [counter] = await db.select({ seq: changeCounter.seq }).from(changeCounter).where(eq(changeCounter.headId, headId));
  const d = describeHead(headId, counter?.seq ?? 0);
  return { owner: d.owner, url, protocol: d.protocol, extensions: d.extensions, render: d.render };
}
