// Producer credentials (RFC §12): a bearer token bound to exactly one namespace root.
// `Authorization: Bearer <token>` → sha256 → producer_tokens. Human sessions never authenticate here.

import { PbcpError, URGENCIES, type Urgency } from '@pbcp/core';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../db/client';
import { producerTokens } from '../../db/schema';

export interface Producer {
  headId: string;
  root: string;
  instance: string | null;
  executor: boolean;
  ceiling: Urgency;
}

const ROOT = /^[A-Za-z0-9-]+$/;

export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** The bearer token from a request, or null. Any other scheme (`Session` included) is no producer credential. */
export function bearerToken(req: Request): string | null {
  const m = /^Bearer +(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

/** §7.1 step 1: no token, or one the head does not accept, is 401 `unauthorized`. */
export async function authenticateProducer(db: Db, req: Request): Promise<Producer> {
  const token = bearerToken(req);
  if (token === null) throw new PbcpError('unauthorized', 'a producer token is required: Authorization: Bearer <token>');
  const [row] = await db
    .select()
    .from(producerTokens)
    .where(and(eq(producerTokens.tokenHash, hashToken(token)), isNull(producerTokens.revokedAt)));
  if (!row) throw new PbcpError('unauthorized', 'the producer token is not valid');
  return {
    headId: row.headId,
    root: row.root,
    instance: row.instance,
    executor: row.executor,
    ceiling: (URGENCIES as readonly string[]).includes(row.urgencyCeiling) ? (row.urgencyCeiling as Urgency) : 'brief',
  };
}

export interface MintOptions {
  headId: string;
  root: string;
  instance?: string;
  executor?: boolean;
  /** §9: a new producer defaults to `brief` until the person raises it. */
  ceiling?: Urgency;
}

/** Issues a token for `root` on a head. The plaintext is returned once and only its hash is stored. */
export async function mintProducerToken(db: Db, opts: MintOptions): Promise<string> {
  if (!ROOT.test(opts.root)) throw new Error(`root must match the producer grammar (§5): ${opts.root}`);
  // A.1: the head acts as the producer of its own cards and owns the head: root; no token is issued for it.
  if (opts.root === 'head') throw new Error('the head: root belongs to the head itself; no token is issued for it');
  const token = `pbcp_${randomBytes(32).toString('base64url')}`;
  await db.insert(producerTokens).values({
    tokenHash: hashToken(token),
    headId: opts.headId,
    root: opts.root,
    instance: opts.instance ?? null,
    executor: opts.executor ?? false,
    urgencyCeiling: opts.ceiling ?? 'brief',
  });
  return token;
}
