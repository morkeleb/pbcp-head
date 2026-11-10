// A head's data key (lib/crypto.ts): created on the head's first write, kept only wrapped on its row, unwrapped for the
// request that needs it and held nowhere else. Step one unwraps with the deployment's master key; step two will hand a
// session's key material in instead, which is why callers ask this module rather than the wrap.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { heads } from '../db/schema';
import { masterKey, masterWrap, newDataKey, type KeyWrap } from './crypto';
import type { Tx } from './store';

/** The wrap in use: the master key's (step one). */
export const currentWrap = (): KeyWrap => masterWrap();

/**
 * The head's data key, unwrapped. `create`: make one on the head's first write. Null when the head has none and
 * `create` is false (a head that has never stored content). Throws when the key cannot be unwrapped (no master key, a
 * wrong one, or a wrap that was tampered with): content is never written in clear instead.
 */
export async function dataKey(db: Db | Tx, headId: string, { create = false }: { create?: boolean } = {}): Promise<Buffer | null> {
  const [row] = await db.select({ wrapped: heads.dataKey }).from(heads).where(eq(heads.id, headId));
  if (!row) return null;
  if (row.wrapped) return currentWrap().unwrap(headId, row.wrapped);
  if (!create) return null;
  const wrap = currentWrap();
  const key = newDataKey();
  const made = await db.update(heads).set({ dataKey: wrap.wrap(headId, key) }).where(and(eq(heads.id, headId), isNull(heads.dataKey))).returning({ id: heads.id });
  if (made.length > 0) return key;
  // Another request made it first: use that one.
  return dataKey(db, headId);
}

/** A per-call cache: one unwrap per head for the duration of one operation (a request), then dropped with it. */
export function keyring(db: Db | Tx) {
  const keys = new Map<string, Promise<Buffer | null>>();
  return (headId: string, opts: { create?: boolean } = {}) => {
    const hit = keys.get(headId);
    if (hit && !opts.create) return hit;
    const k = dataKey(db, headId, opts);
    keys.set(headId, k);
    return k;
  };
}

/**
 * Refuses to start when any head has a data key and HEAD_MASTER_KEY is missing or malformed: a head that cannot read its
 * content fails the deploy loudly rather than serving errors (instrumentation.ts, and the backfill before the build).
 */
export async function requireMasterKeyIfNeeded(db: Db, env: Record<string, string | undefined> = process.env): Promise<void> {
  const key = masterKey(env); // throws on a malformed one
  if (key) return;
  const [any] = await db.select({ id: heads.id }).from(heads).where(sql`${heads.dataKey} is not null`).limit(1);
  if (any) throw new Error('HEAD_MASTER_KEY is not set, and this database holds encrypted card content: refusing to start. Set it to the key the content was written with (docs/deploy.md "At rest").');
}
