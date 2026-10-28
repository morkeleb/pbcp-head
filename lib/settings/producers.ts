// Producer tokens from the owner's side (RFC §12: a token bound to one namespace root; revoking it is how to silence a
// producer): list, mint, revoke. The settings routes (app/api/me/settings/producers) and the scripts
// (scripts/mint-token.ts, scripts/revoke-token.ts) call these, so there is one way to issue and withdraw a token.

import { URGENCIES, type Urgency } from '@pbcp/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { producerTokens } from '../../db/schema';
import { hashToken, mintProducerToken } from '../auth/producer';
import { iso } from '../clock';
import { HttpError } from '../http';

/** A root is an id's producer segment (§5): letters, digits and -. `head` is the head's own (A.1). */
const ROOT = /^[A-Za-z0-9-]+$/;
const ROOT_MAX = 64;

/** Whether `root` can be a producer's root: the §5 segment grammar, at most ROOT_MAX characters, not `head`. */
export const isProducerRoot = (root: string) => ROOT.test(root) && root.length <= ROOT_MAX && root !== 'head';

/** Whether `root` already has a live token on the head (for `instance`, when given). */
export async function rootTaken(db: Db, headId: string, root: string, instance: string | null = null): Promise<boolean> {
  const live = await db
    .select({ instance: producerTokens.instance })
    .from(producerTokens)
    .where(and(eq(producerTokens.headId, headId), eq(producerTokens.root, root), isNull(producerTokens.revokedAt)));
  return live.some((t) => (t.instance ?? null) === instance);
}

/** A token's id in the owner's API: the first 16 hex digits of the stored sha256, never the token itself. */
export const tokenId = (hash: Buffer) => hash.toString('hex').slice(0, 16);

export interface TokenRow {
  id: string;
  root: string;
  instance: string | null;
  executor: boolean;
  ceiling: Urgency;
  created_at: string;
  last_used_at: string | null;
  /** Set when the producer paired itself (lib/settings/pairing.ts): the name it gave, its address, when. */
  paired: { name: string | null; address: string | null; at: string } | null;
}

/** The head's live producer tokens, oldest first. */
export async function listTokens(db: Db, headId: string): Promise<TokenRow[]> {
  const rows = await db
    .select()
    .from(producerTokens)
    .where(and(eq(producerTokens.headId, headId), isNull(producerTokens.revokedAt)))
    .orderBy(asc(producerTokens.createdAt));
  return rows.map((r) => ({
    id: tokenId(r.tokenHash),
    root: r.root,
    instance: r.instance,
    executor: r.executor,
    ceiling: (URGENCIES as readonly string[]).includes(r.urgencyCeiling) ? (r.urgencyCeiling as Urgency) : 'brief',
    created_at: iso(r.createdAt),
    last_used_at: r.lastUsedAt ? iso(r.lastUsedAt) : null,
    paired: r.pairedAt ? { name: r.pairedName, address: r.pairedAddress, at: iso(r.pairedAt) } : null,
  }));
}

export interface MintRequest {
  root: string;
  instance?: string;
  executor?: boolean;
  ceiling?: Urgency;
}

/**
 * Issues a token for `root`. The root must be an id's producer segment (§5), not `head` (A.1), and not already held by
 * a live token (with the same instance): two installations of one connector are two instances, two tokens (§12). The
 * plaintext is returned once; only its hash is stored, so it can never be shown again.
 */
export async function mintToken(db: Db, headId: string, req: MintRequest): Promise<{ token: string; producer: TokenRow }> {
  const root = req.root.trim();
  if (!ROOT.test(root) || root.length > ROOT_MAX) throw new HttpError(400, 'invalid_root', `a producer root is 1 to ${ROOT_MAX} letters, digits or - (§5): an id's first segment`);
  if (root === 'head') throw new HttpError(400, 'invalid_root', 'the root head belongs to the head itself (A.1)');
  if (req.instance !== undefined && !ROOT.test(req.instance)) throw new HttpError(400, 'invalid_request', 'an instance is letters, digits or -');
  const live = await db
    .select({ instance: producerTokens.instance })
    .from(producerTokens)
    .where(and(eq(producerTokens.headId, headId), eq(producerTokens.root, root), isNull(producerTokens.revokedAt)));
  if (live.some((t) => (t.instance ?? null) === (req.instance ?? null))) {
    throw new HttpError(409, 'root_in_use', `${root} already has a token${req.instance ? ` for instance ${req.instance}` : ''}: revoke it first, or name another instance`);
  }
  const token = await mintProducerToken(db, { headId, root, ...(req.instance ? { instance: req.instance } : {}), executor: req.executor ?? false, ceiling: req.ceiling ?? 'brief' });
  const producer = (await listTokens(db, headId)).find((t) => t.id === tokenId(hashToken(token)))!;
  return { token, producer };
}

/** Revokes one token by its id; its producer gets 401 from the next request on (§7.1, §12). */
export async function revokeToken(db: Db, headId: string, id: string): Promise<void> {
  const rows = await db.select({ hash: producerTokens.tokenHash }).from(producerTokens).where(and(eq(producerTokens.headId, headId), isNull(producerTokens.revokedAt)));
  const hit = rows.find((r) => tokenId(r.hash) === id);
  if (!hit) throw new HttpError(404, 'not_found', `no live producer token ${id}`);
  await db.update(producerTokens).set({ revokedAt: new Date() }).where(eq(producerTokens.tokenHash, hit.hash));
}

/** Revokes every live token of a root (the script's form, and the root-wide control). */
export async function revokeRoot(db: Db, headId: string, root: string): Promise<number> {
  const r = await db
    .update(producerTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(producerTokens.headId, headId), eq(producerTokens.root, root), isNull(producerTokens.revokedAt)))
    .returning({ root: producerTokens.root });
  return r.length;
}
