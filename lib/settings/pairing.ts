// Producer pairing: the owner makes a short code (Settings → Producers) and gives it to an agent, which trades it at
// POST /api/pair for a token of its own, bound to the root it chooses (RFC §12). The code is the credential, so:
//
// - 6 characters from an alphabet without look-alikes, shown as two groups ("K7Q-4MX"); valid 10 minutes; single use;
//   bound to the head that made it; only its sha256 is stored.
// - A failed attempt (a code that does not exist, has expired, or was used) burns every outstanding code on this
//   deployment and answers 400 invalid_code and nothing else: a guess never gets a second try at any code, and a wrong
//   code cannot say which code it was aimed at. With a good code, a root that is malformed (400 invalid_root) or taken
//   (409 root_taken) is said so, and the code stays usable.
// - The route is rate-limited per address (lib/rate-limit.ts `pair`). Neither the code nor the token is ever logged.
//
// A pairing is recorded on the token row (name, address, time) and as a `head:producer:<root>` signal at urgency log,
// so it is in the owner's record.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { pairingCodes } from '../../db/schema';
import { mintProducerToken } from '../auth/producer';
import { iso, now } from '../clock';
import { HttpError } from '../http';
import { submitCard } from '../protocol';
import { isProducerRoot, rootTaken } from './producers';

/** No 0/O, 1/I/L: what is read aloud or copied by hand comes back the same. */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PAIRING_LENGTH = 6;
export const PAIRING_TTL_SECONDS = 10 * 60;

const hashCode = (code: string) => createHash('sha256').update(`pbcp-pairing:${code}`, 'utf8').digest();
/** What the agent typed, as the code: case and separators do not matter. */
export const normaliseCode = (input: string) => input.toUpperCase().replace(/[^0-9A-Z]/g, '');
/** "K7Q4MX" → "K7Q-4MX". */
export const formatCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

export interface PairingCode {
  id: string;
  created_at: string;
  expires_at: string;
}

/** Makes a code for the head. The code itself is in this answer only. */
export async function createPairingCode(db: Db, headId: string): Promise<PairingCode & { code: string }> {
  for (;;) {
    const code = Array.from({ length: PAIRING_LENGTH }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('');
    const at = new Date(now());
    const row = { id: randomBytes(8).toString('hex'), headId, codeHash: hashCode(code), createdAt: at, expiresAt: new Date(at.getTime() + PAIRING_TTL_SECONDS * 1000) };
    // A code another head holds (or one this head held before) is the same hash: draw again.
    const inserted = await db.insert(pairingCodes).values(row).onConflictDoNothing().returning({ id: pairingCodes.id });
    if (inserted.length) return { id: row.id, code: formatCode(code), created_at: iso(row.createdAt), expires_at: iso(row.expiresAt) };
  }
}

/** The head's codes that can still be used, oldest first. */
export async function listPairingCodes(db: Db, headId: string): Promise<PairingCode[]> {
  const rows = await db
    .select()
    .from(pairingCodes)
    .where(and(eq(pairingCodes.headId, headId), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, new Date(now()))))
    .orderBy(asc(pairingCodes.createdAt));
  return rows.map((r) => ({ id: r.id, created_at: iso(r.createdAt), expires_at: iso(r.expiresAt) }));
}

export async function cancelPairingCode(db: Db, headId: string, id: string): Promise<void> {
  const r = await db
    .update(pairingCodes)
    .set({ usedAt: new Date(now()) })
    .where(and(eq(pairingCodes.headId, headId), eq(pairingCodes.id, id), isNull(pairingCodes.usedAt)))
    .returning({ id: pairingCodes.id });
  if (r.length === 0) throw new HttpError(404, 'not_found', `no open pairing code ${id}`);
}

const invalidCode = () => new HttpError(400, 'invalid_code', 'the pairing code is not valid; ask the owner for a new one');

/** Every outstanding code on the deployment, used up: after a failed attempt, nothing a guess could reach survives. */
async function burnAll(db: Db): Promise<void> {
  await db.update(pairingCodes).set({ usedAt: new Date(now()) }).where(isNull(pairingCodes.usedAt));
}

export interface PairRequest {
  code?: unknown;
  root?: unknown;
  name?: unknown;
}

/**
 * POST /api/pair: trades a pairing code for a producer token bound to `root` on the code's head. `api` is where the
 * producer operations are (§7.5), `owner` the person id cards are addressed to (§10).
 */
export async function pair(db: Db, body: PairRequest, address: string, api: string): Promise<{ token: string; api: string; owner: string; root: string }> {
  const at = new Date(now());
  const code = typeof body.code === 'string' ? normaliseCode(body.code) : '';
  const [held] =
    code.length === PAIRING_LENGTH
      ? await db
          .select()
          .from(pairingCodes)
          .where(and(eq(pairingCodes.codeHash, hashCode(code)), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, at)))
      : [];
  if (!held) {
    await burnAll(db);
    throw invalidCode();
  }

  // A good code: the root's faults are the producer's to fix, and the code stays usable.
  const root = typeof body.root === 'string' ? body.root.trim() : '';
  if (!isProducerRoot(root)) throw new HttpError(400, 'invalid_root', 'a producer root is 1 to 64 letters, digits or - (RFC §5), and not head');
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : null;
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') throw new HttpError(400, 'invalid_request', 'name, if given, is a string');
  if (await rootTaken(db, held.headId, root)) throw new HttpError(409, 'root_taken', `${root} already has a token on this head; choose another root`);

  const token = await db.transaction(async (tx) => {
    // Claim the code: of two attempts with it at once, one gets it.
    const claimed = await tx
      .update(pairingCodes)
      .set({ usedAt: at })
      .where(and(eq(pairingCodes.id, held.id), isNull(pairingCodes.usedAt)))
      .returning({ id: pairingCodes.id });
    if (claimed.length === 0) throw invalidCode();
    return mintProducerToken(tx as unknown as Db, { headId: held.headId, root, paired: { name, address, at } });
  });

  // In the owner's record: a signal from the head at log urgency (A.1: the head owns the head: root).
  const card = {
    protocol: 'pbcp/1',
    id: `head:producer:${root}`,
    kind: 'signal',
    to_person: held.headId,
    producer: 'head',
    urgency: 'log',
    title: `${name ?? root} paired as \`${root}\``,
    body: `Paired at ${iso(at)} from ${address}${name ? `, calling itself ${name}` : ''}. Its token is bound to the root \`${root}\`; revoke it in Settings → Producers.`,
    emitted_at: iso(at),
  };
  await submitCard(db, { headId: held.headId, root: 'head', ceiling: 'brief' }, JSON.stringify(card), encodeURIComponent(card.id));

  return { token, api, owner: held.headId, root };
}
