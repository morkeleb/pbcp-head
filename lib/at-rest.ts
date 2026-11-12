// The operator's side of encryption at rest (docs/deploy.md "At rest"): the --verify count, the backfill's one remaining
// job (invite addresses kept in clear before encryption, replaced by their digest), rewrapping every head's data key
// under a new master key, deleting a head by its key first (crypto-shredding), and printing one card. Scripts in
// scripts/ are thin wrappers around these. Sealing cards, the decision log and diagrams from their plaintext columns was
// deploy 1's work; migration 0024 dropped those columns once every row was sealed.

import { and, eq, inArray, isNull, notLike, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  cards, changeCounter, decisionLog, devices, diagrams, heads, identities, inviteRequests, labelCeilings, oauthCodes, pairingCodes,
  producerTokens, sensitivityFloors,
} from '../db/schema';
import { digest, MasterKeyWrap, masterWrap, seal } from './crypto';
import { defaultHead } from './heads';
import { dataKey } from './keys';
import { openRows, toCard } from './store';

export interface Remaining {
  cards: number;
  decision_log: number;
  diagrams: number;
  invite_requests: number;
}

/** An invite request whose address is in clear: not sealed, or sealed beside its address rather than its digest. */
const plainInvite = or(isNull(inviteRequests.content), notLike(inviteRequests.email, 'd:%'));

/**
 * How many rows hold content outside its sealed form (`pnpm encrypt-backfill --verify`). Cards, decision-log rows and
 * diagrams without content cannot occur after migration 0024 (it refuses to run while any could); they are counted so a
 * row written around the head is still caught.
 */
export async function remaining(db: Db): Promise<Remaining> {
  const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;
  return {
    cards: await count(db.select({ n }).from(cards).where(sql`${cards.content} is null or not (${cards.content} ? 'doc') or not (${cards.content} ? 'mac')`)),
    decision_log: await count(db.select({ n }).from(decisionLog).where(isNull(decisionLog.content))),
    diagrams: await count(db.select({ n }).from(diagrams).where(isNull(diagrams.content))),
    invite_requests: await count(db.select({ n }).from(inviteRequests).where(plainInvite)),
  };
}

const total = (r: Remaining) => r.cards + r.decision_log + r.diagrams + r.invite_requests;

/**
 * Seals what is still in clear, idempotently: invite requests recorded before the deployment had a head (or before
 * encryption) get their address sealed under the deployment head's key and replaced by its keyed digest, as
 * lib/invites.ts writes them. Exits at once when nothing is left.
 */
export async function backfill(db: Db, progress: (line: string) => void = () => undefined): Promise<Remaining> {
  const before = await remaining(db);
  if (total(before) === 0) return before;
  const head = await defaultHead(db);
  if (head && before.invite_requests > 0) {
    const key = (await dataKey(db, head, { create: true }))!;
    const rows = await db.select().from(inviteRequests).where(plainInvite);
    for (const r of rows) {
      // Until it is replaced, the email column holds the address in clear; a row sealed by deploy 1 keeps its sealed copy.
      const sealed = (r.content as { email?: string } | null)?.email ?? seal(key, head, 'invite_requests.email', String(r.id), r.email);
      await db
        .update(inviteRequests)
        .set({ email: `d:${digest(key, 'invite.email', r.email.toLowerCase())}`, content: { email: sealed } })
        .where(eq(inviteRequests.id, r.id));
    }
    progress(`invite requests: ${rows.length} sealed`);
  }
  return remaining(db);
}

/**
 * Rewraps every head's data key under a new master key, one transaction per head (`pnpm rewrap --new-master <key>`).
 * Cards are not touched: the data key itself never changes. Set HEAD_MASTER_KEY to the new key once it has run.
 */
export async function rewrap(db: Db, newMaster: Buffer, progress: (line: string) => void = () => undefined): Promise<number> {
  const current = masterWrap();
  const next = new MasterKeyWrap(newMaster);
  const all = await db.select({ id: heads.id }).from(heads).where(sql`${heads.dataKey} is not null`);
  for (const { id } of all) {
    await db.transaction(async (tx) => {
      const [h] = await tx.select({ wrapped: heads.dataKey }).from(heads).where(eq(heads.id, id)).for('update');
      if (!h?.wrapped) return;
      await tx.update(heads).set({ dataKey: next.wrap(id, current.unwrap(id, h.wrapped)) }).where(eq(heads.id, id));
    });
    progress(`rewrapped ${id}`);
  }
  return all.length;
}

/** Destroys a head's data key: every sealed value of the head is unreadable from this moment (crypto-shredding). */
export async function destroyKey(db: Db, headId: string): Promise<void> {
  await db.update(heads).set({ dataKey: null }).where(eq(heads.id, headId));
}

/** Deletes a head: its data key first, then its rows (`pnpm head:delete <owner>`). */
export async function deleteHead(db: Db, headId: string): Promise<void> {
  await destroyKey(db, headId);
  await db.transaction(async (tx) => {
    const ids = (await tx.select({ id: devices.id }).from(devices).where(eq(devices.headId, headId))).map((d) => d.id);
    await tx.delete(decisionLog).where(eq(decisionLog.headId, headId));
    await tx.delete(cards).where(eq(cards.headId, headId));
    await tx.delete(oauthCodes).where(eq(oauthCodes.headId, headId));
    if (ids.length) await tx.delete(devices).where(inArray(devices.id, ids));
    await tx.delete(identities).where(eq(identities.headId, headId));
    await tx.delete(pairingCodes).where(eq(pairingCodes.headId, headId));
    await tx.delete(producerTokens).where(eq(producerTokens.headId, headId));
    await tx.delete(labelCeilings).where(eq(labelCeilings.headId, headId));
    await tx.delete(sensitivityFloors).where(eq(sensitivityFloors.headId, headId));
    await tx.delete(changeCounter).where(eq(changeCounter.headId, headId));
    await tx.delete(heads).where(eq(heads.id, headId));
  });
}

/** One card in clear, for the operator (`pnpm card:decrypt <id>`): the head's, or the only head holding that id. */
export async function decryptCard(db: Db, id: string, headId?: string) {
  const rows = await db.select().from(cards).where(and(eq(cards.id, id), ...(headId ? [eq(cards.headId, headId)] : [])));
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`card ${id} is held by more than one head; name one with --head`);
  const [row] = await openRows(db, rows);
  if (!row) throw new Error(`card ${id} did not open: its sealed content failed its integrity check`);
  return { head: row.headId, card: toCard(row), rendered_html: row.renderedHtml, comment: row.comment, edited_proposal: row.editedProposal };
}
