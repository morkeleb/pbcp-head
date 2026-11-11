// RFC 0.9 `sensitivity` (§4.1, §9, §12): how carefully the head handles a card's content and decision.
//
// The producer sends a floor on the card (`normal` < `private` < `confirm`); the owner may raise it, never lower it, per
// producer, per label and for every card (§9). The effective value is core's `effectiveSensitivity` of the card's own
// and every policy that applies, computed whenever the card is handled and never stored: raising a policy protects the
// cards already stored. This differs from the urgency ceiling on purpose: a ceiling is about attention and applies to
// content stored from then on (§9), a floor is about exposure and applies to every card from the moment it is set. The
// card's own `sensitivity` is never rewritten: it stays as sent, for equality (§5) and in what the head returns and syncs.

import { effectiveSensitivity, SENSITIVITIES, type Sensitivity } from '@pbcp/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cards, heads, sensitivityFloors } from '../db/schema';
import type { ParagraphParts } from './brief/paragraph';
import { HttpError } from './http';
import { openRows, type Tx } from './store';

export { SENSITIVITIES, type Sensitivity };

export { REAUTH_WINDOW_SECONDS } from './auth/reauth-window';

/** The owner's floors (§9): for every card, per producer root, per label. */
export interface SensitivityPolicy {
  all: Sensitivity | null;
  producers: ReadonlyMap<string, Sensitivity>;
  labels: ReadonlyMap<string, Sensitivity>;
}

export const NO_POLICY: SensitivityPolicy = { all: null, producers: new Map(), labels: new Map() };

export const isSensitivity = (v: unknown): v is Sensitivity => (SENSITIVITIES as readonly unknown[]).includes(v);

/** The head's floors as they stand now. */
export async function loadPolicy(db: Db | Tx, headId: string): Promise<SensitivityPolicy> {
  const [head] = await db.select({ floor: heads.sensitivityFloor }).from(heads).where(eq(heads.id, headId));
  const rows = await db.select().from(sensitivityFloors).where(eq(sensitivityFloors.headId, headId));
  const producers = new Map<string, Sensitivity>();
  const labels = new Map<string, Sensitivity>();
  for (const r of rows) {
    if (!isSensitivity(r.floor)) continue;
    (r.scope === 'producer' ? producers : labels).set(r.key, r.floor);
  }
  return { all: isSensitivity(head?.floor) ? head.floor : null, producers, labels };
}

/** The card's effective sensitivity under `policy`: the highest of its own and every floor that applies (§9). */
export function effectiveOf(card: { producer: string; labels?: readonly string[]; sensitivity?: Sensitivity }, policy: SensitivityPolicy): Sensitivity {
  return effectiveSensitivity(
    card.sensitivity,
    policy.producers.get(card.producer),
    ...(card.labels ?? []).map((l) => policy.labels.get(l)),
    policy.all ?? undefined,
  );
}

/** §4.1 `private`, which `confirm` includes: the card's lead and body stay inside the owner's signed-in session. */
export const isPrivate = (s: Sensitivity): boolean => s !== 'normal';

/** Sets or clears (null) the owner's floor on a producer root or a label. */
export async function setFloor(db: Db, headId: string, scope: 'producer' | 'label', key: string, floor: Sensitivity | null): Promise<void> {
  await db.transaction(async (tx) => {
    await upsertPolicy(tx, headId, scope, key, { floor });
    await bumpSettingsSeq(tx, headId);
  });
}

/** A label's row in sensitivity_floors: one field set, the other kept; a row left with neither is removed. */
async function upsertPolicy(tx: Db | Tx, headId: string, scope: 'producer' | 'label', key: string, set: { floor?: Sensitivity | null; foldPolicy?: 'count' | null }) {
  const where = and(eq(sensitivityFloors.headId, headId), eq(sensitivityFloors.scope, scope), eq(sensitivityFloors.key, key));
  await tx
    .insert(sensitivityFloors)
    .values({ headId, scope, key, floor: set.floor ?? null, foldPolicy: set.foldPolicy ?? null })
    .onConflictDoUpdate({ target: [sensitivityFloors.headId, sensitivityFloors.scope, sensitivityFloors.key], set });
  await tx.delete(sensitivityFloors).where(and(where, isNull(sensitivityFloors.floor), isNull(sensitivityFloors.foldPolicy)));
}

// RFC 0.9 §9 "Folding": a fold policy per label, `list` (the default) or `count`. It changes the brief's fold, never the
// card: a task under a `count` label is counted as routine in the paragraph and grouped apart in the Tasks section.
export const FOLD_POLICIES = ['list', 'count'] as const;
export type FoldPolicy = (typeof FOLD_POLICIES)[number];

/** Labels the owner set to fold as a count. */
export async function countLabels(db: Db | Tx, headId: string): Promise<string[]> {
  const rows = await db
    .select({ key: sensitivityFloors.key })
    .from(sensitivityFloors)
    .where(and(eq(sensitivityFloors.headId, headId), eq(sensitivityFloors.scope, 'label'), eq(sensitivityFloors.foldPolicy, 'count')));
  return rows.map((r) => r.key).sort();
}

/** Sets a label's fold policy; `list` (or null) is the default and clears it. Moves settings_seq, as a floor does. */
export async function setFoldPolicy(db: Db, headId: string, label: string, policy: FoldPolicy | null): Promise<void> {
  await db.transaction(async (tx) => {
    await upsertPolicy(tx, headId, 'label', label, { foldPolicy: policy === 'count' ? 'count' : null });
    await bumpSettingsSeq(tx, headId);
  });
}

/** Moves `heads.settings_seq`: call inside the transaction that changes a floor. */
export async function bumpSettingsSeq(tx: Db | Tx, headId: string): Promise<void> {
  await tx.update(heads).set({ settingsSeq: sql`${heads.settingsSeq} + 1` }).where(eq(heads.id, headId));
}

/** Every floor, as the owner's devices keep them (GET /api/me/settings `sensitivity_floors`). */
export async function floorsOf(db: Db, headId: string): Promise<{ producers: Record<string, Sensitivity>; labels: Record<string, Sensitivity> }> {
  const p = await loadPolicy(db, headId);
  return { producers: Object.fromEntries(p.producers), labels: Object.fromEntries(p.labels) };
}

/** A floor from a request body: a sensitivity, or null to clear it. */
export function parseFloor(v: unknown, field = 'sensitivity'): Sensitivity | null {
  if (v === null) return null;
  if (isSensitivity(v)) return v;
  throw new HttpError(400, 'invalid_request', `${field} must be one of ${SENSITIVITIES.join(', ')}, or null`);
}

const PART_LISTS = ['decisions', 'tasks', 'decided', 'orders', 'mattered', 'yesterday'] as const;

/**
 * The paragraph's entries with their cards' `sensitivity` (as sent) and `effective_sensitivity` (§9, as of now), so a
 * client can count private entries without their content (RFC 0.9 §4.1; docs/briefing-machine.md "Sensitivity"). An entry
 * whose card the head no longer holds is `normal`.
 */
export async function annotateParts(db: Db, headId: string, parts: ParagraphParts, policy?: SensitivityPolicy): Promise<ParagraphParts> {
  const ids = [...new Set(PART_LISTS.flatMap((k) => (parts[k] ?? []).map((e) => e.id)))];
  if (ids.length === 0) return parts;
  const p = policy ?? (await loadPolicy(db, headId));
  // At rest: labels and titles are sealed; the rows are opened for this call (lib/store.ts openRows).
  const rows = (await openRows(db, await db.select().from(cards).where(and(eq(cards.headId, headId), inArray(cards.id, ids))))).map((r) => ({ id: r.id, producer: r.producer, doc: r.producerDoc }));
  const of = new Map(
    rows.map((r) => {
      const doc = r.doc as { labels?: string[]; sensitivity?: Sensitivity; title?: string; kind?: string };
      return [
        r.id,
        {
          producer: r.producer,
          ...(doc.kind ? { kind: doc.kind } : {}),
          ...(doc.title !== undefined ? { title: doc.title } : {}),
          sensitivity: doc.sensitivity ?? ('normal' as const),
          effective_sensitivity: effectiveOf({ producer: r.producer, labels: doc.labels ?? [], ...(doc.sensitivity ? { sensitivity: doc.sensitivity } : {}) }, p),
        },
      ];
    }),
  );
  const mark = <T extends { id: string }>(e: T) => ({ ...e, ...(of.get(e.id) ?? { sensitivity: 'normal' as const, effective_sensitivity: 'normal' as const }) });
  // (Each entry also gains its card's producer, kind and title, so a private entry can be shown by those alone.)
  const out: ParagraphParts = { ...parts };
  for (const k of PART_LISTS) if (parts[k]) (out as unknown as Record<string, unknown>)[k] = (parts[k] as Array<{ id: string }>).map(mark);
  return out;
}

