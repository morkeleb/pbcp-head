// The operator's side of encryption at rest (docs/deploy.md "At rest"): the backfill that seals rows still in their
// plaintext form, its --verify count, rewrapping every head's data key under a new master key, deleting a head by its
// key first (crypto-shredding), and printing one card. Scripts in scripts/ are thin wrappers around these.

import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  cards, changeCounter, decisionLog, devices, diagrams, heads, identities, inviteRequests, labelCeilings, oauthCodes, pairingCodes,
  producerTokens, sensitivityFloors,
} from '../db/schema';
import { MasterKeyWrap, masterWrap, seal } from './crypto';
import { defaultHead } from './heads';
import { dataKey } from './keys';
import { openRows, toCard } from './store';
import { cardNeedsSealing, openCardRow, sealCardRow, sealDiagram, sealLog } from './vault';

const BATCH = 200;

/** Rows a query can tell are not yet sealed; `cardNeedsSealing` decides each one exactly. */
const cardCandidates = sql`(${cards.content} is null or not (${cards.content} ? 'doc') or not (${cards.content} ? 'mac')
  or (${cards.renderedHtml} is not null and not (${cards.content} ? 'html'))
  or (${cards.renderedActions} is not null and not (${cards.content} ? 'actions'))
  or (${cards.renderedMeta} is not null and not (${cards.content} ? 'meta'))
  or (${cards.renderedParagraph} is not null and not (${cards.content} ? 'paragraph'))
  or (${cards.comment} is not null and not (${cards.content} ? 'comment'))
  or (${cards.editedProposal} is not null and not (${cards.content} ? 'edited'))
  or (${cards.decidedDoc} is not null and not (${cards.content} ? 'decided')))`;

/** Diagram rows drawn before the cache was per head: plaintext, not yet copied to the heads that use them. */
const oldDiagram = sql`(${diagrams.content} is null and (${diagrams.svg} is not null or ${diagrams.error} is not null or ${diagrams.svgDark} is not null or ${diagrams.errorDark} is not null))`;

export interface Remaining {
  cards: number;
  decision_log: number;
  diagrams: number;
  invite_requests: number;
}

/** How many rows still hold content only in plaintext (`pnpm encrypt-backfill --verify`). Zero everywhere: the drop-columns migration may run. */
export async function remaining(db: Db): Promise<Remaining> {
  let cardCount = 0;
  for (let after = ''; ; ) {
    const rows = await db.select().from(cards).where(and(cardCandidates, gt(sql`${cards.headId} || '/' || ${cards.id}`, after))).orderBy(asc(sql`${cards.headId} || '/' || ${cards.id}`)).limit(BATCH);
    cardCount += rows.filter(cardNeedsSealing).length;
    if (rows.length < BATCH) break;
    after = `${rows.at(-1)!.headId}/${rows.at(-1)!.id}`;
  }
  const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  return {
    cards: cardCount,
    decision_log: await count(db.select({ n: sql<number>`count(*)::int` }).from(decisionLog).where(isNull(decisionLog.content))),
    diagrams: await count(db.select({ n: sql<number>`count(*)::int` }).from(diagrams).where(oldDiagram)),
    invite_requests: await count(db.select({ n: sql<number>`count(*)::int` }).from(inviteRequests).where(isNull(inviteRequests.content))),
  };
}

const total = (r: Remaining) => r.cards + r.decision_log + r.diagrams + r.invite_requests;

/**
 * Seals every row still in its plaintext form, in batches, resumable and idempotent: a row already sealed is passed over,
 * so a run that stops is run again. Plaintext columns are left as they are: nothing is dropped here (the drop-columns
 * migration, after --verify reports zero on production, is the point of no return). Exits at once when nothing is left.
 */
export async function backfill(db: Db, progress: (line: string) => void = () => undefined): Promise<Remaining> {
  const before = await remaining(db);
  if (total(before) === 0) return before;
  progress(`to seal: ${before.cards} cards, ${before.decision_log} decision-log rows, ${before.diagrams} diagrams, ${before.invite_requests} invite requests`);

  // Cards, a batch at a time, each row in its own small update; diagrams the head's cards draw are noted on the way.
  const used = new Map<string, Set<string>>(); // head → old diagram hashes its cards show
  let sealed = 0;
  for (let after = ''; ; ) {
    const rows = await db.select().from(cards).where(gt(sql`${cards.headId} || '/' || ${cards.id}`, after)).orderBy(asc(sql`${cards.headId} || '/' || ${cards.id}`)).limit(BATCH);
    for (const row of rows) {
      const key = (await dataKey(db, row.headId, { create: true }))!;
      if (cardNeedsSealing(row)) {
        await db.update(cards).set({ content: sealCardRow(row, key) }).where(and(eq(cards.headId, row.headId), eq(cards.id, row.id)));
        sealed++;
      }
      const html = openCardRow({ ...row, content: row.content }, key).renderedHtml ?? row.renderedHtml ?? '';
      for (const m of html.matchAll(/\/api\/me\/svg\/([0-9a-f]{64})(?!\?h=)/g)) used.set(row.headId, (used.get(row.headId) ?? new Set()).add(m[1]!));
    }
    if (rows.length > 0) progress(`cards: ${sealed} sealed of ${before.cards}`);
    if (rows.length < BATCH) break;
    after = `${rows.at(-1)!.headId}/${rows.at(-1)!.id}`;
  }

  // The decision log.
  for (;;) {
    const rows = await db.select().from(decisionLog).where(isNull(decisionLog.content)).orderBy(asc(decisionLog.seq)).limit(BATCH);
    for (const r of rows) {
      const key = (await dataKey(db, r.headId, { create: true }))!;
      const s = sealLog(key, r.headId, { decidedDoc: r.decidedDoc as Record<string, unknown>, comment: r.comment, editedProposal: r.editedProposal });
      await db.update(decisionLog).set({ content: s.content }).where(eq(decisionLog.seq, r.seq));
    }
    if (rows.length > 0) progress(`decision log: ${rows.length} sealed`);
    if (rows.length < BATCH) break;
  }

  // Diagrams from before the cache was per head: copied, sealed, to each head whose cards show them; then marked done.
  const { scopedHash } = await import('./render');
  for (const [headId, hashes] of used) {
    const key = (await dataKey(db, headId, { create: true }))!;
    const olds = await db.select().from(diagrams).where(and(inArray(diagrams.hash, [...hashes]), oldDiagram));
    for (const d of olds) {
      await db
        .insert(diagrams)
        .values({ hash: scopedHash(headId, d.hash), type: d.type, content: sealDiagram(key, headId, d) })
        .onConflictDoNothing();
    }
  }
  const marked = await db.update(diagrams).set({ content: { migrated: true } }).where(oldDiagram).returning({ hash: diagrams.hash });
  if (marked.length) progress(`diagrams: ${marked.length} copied to their heads, sealed`);

  // Invite requests: under the deployment head's key.
  const head = await defaultHead(db);
  if (head) {
    const key = (await dataKey(db, head, { create: true }))!;
    const rows = await db.select().from(inviteRequests).where(isNull(inviteRequests.content));
    for (const r of rows) await db.update(inviteRequests).set({ content: { email: seal(key, head, 'invite_requests.email', r.email) } }).where(eq(inviteRequests.id, r.id));
    if (rows.length) progress(`invite requests: ${rows.length} sealed`);
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
