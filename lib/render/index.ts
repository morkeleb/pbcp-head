// Render on receipt (RFC §3.1, docs/head-skeleton.md "Rendering pipeline"): a card's body and its choice
// options' bodies become HTML once, server-side, stored beside the card. Diagrams are drawn through a
// cache keyed by sha256 of the sanitised fence. `renderCard` runs after a PUT commits; reads call
// `ensureRendered`, which redraws only what is missing or stale (a failed draw, a newer body).

import { actionId, type Card } from '@pbcp/core';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../../db/client';
import { cards, diagrams } from '../../db/schema';
import { DiagramError, drawSvg } from './draw';
import { renderMarkdown, type DiagramOutcome, type Rendered, type Visual } from './markdown';
import { diagramType } from './mermaid';
import { proxiedImageSrc } from './proxy';
import { sanitiseSvg } from './svg';

/** Bump when the pipeline's output changes, so stored renders are redone on next read. */
export const RENDER_VERSION = 'h2.1';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const g = globalThis as unknown as { __pbcpDraws?: number };
/** Diagrams drawn (cache misses) in this process, for the conformance suite's R07. */
export const drawCount = (): number => g.__pbcpDraws ?? 0;
export const resetDrawCount = (): void => void (g.__pbcpDraws = 0);

/** The diagram dependency of the markdown renderer: cached, drawn on a miss. */
export function cachedDiagrams(db: Db) {
  return async (source: string): Promise<DiagramOutcome> => {
    const hash = sha256(source);
    const [hit] = await db.select().from(diagrams).where(eq(diagrams.hash, hash));
    if (hit) return hit.svg !== null ? { status: 'render', hash } : { status: 'fallback', message: hit.error ?? 'diagram could not be drawn' };
    g.__pbcpDraws = drawCount() + 1;
    let row: typeof diagrams.$inferInsert;
    try {
      // A stable id from the hash keeps the drawing identical across draws (§3.1 Determinism).
      const svg = sanitiseSvg(await drawSvg(source, `d${hash.slice(0, 12)}`), { allowStyle: true });
      row = { hash, type: diagramType(source), svg };
    } catch (e) {
      if (!(e instanceof DiagramError)) throw e; // infrastructure: do not cache, let the next read retry
      row = { hash, type: diagramType(source), error: e.message };
    }
    await db.insert(diagrams).values(row).onConflictDoNothing();
    return row.svg ? { status: 'render', hash } : { status: 'fallback', message: row.error! };
  };
}

export function renderBody(db: Db, body: string): Promise<Rendered> {
  return renderMarkdown(body, { diagram: cachedDiagrams(db), imageSrc: proxiedImageSrc });
}

export interface RenderMeta {
  firstVisual: Visual | null;
  fences: Array<{ type: string; class: string }>;
}

export interface CardRender {
  html: string;
  actions: Record<string, string>;
  meta: RenderMeta;
}

const optionBodies = (card: Card): Array<[string, string]> =>
  (card.actions ?? []).flatMap((a) => (typeof a === 'object' && typeof a.body === 'string' ? [[actionId(a), a.body] as [string, string]] : []));

/** What a stored render was made from; a different value means it is stale. */
export const renderSource = (card: Card): string => sha256(JSON.stringify([RENDER_VERSION, card.body, optionBodies(card)]));

/** Renders a card's body and option bodies and stores them beside it. */
export async function renderCard(db: Db, headId: string, card: Card): Promise<CardRender> {
  const body = await renderBody(db, card.body);
  const actions: Record<string, string> = {};
  for (const [id, md] of optionBodies(card)) actions[id] = (await renderBody(db, md)).html;
  const meta: RenderMeta = { firstVisual: body.firstVisual, fences: body.result.fences.map((f) => ({ type: f.type, class: f.class })) };
  await db
    .update(cards)
    .set({ renderedHtml: body.html, renderedActions: actions, renderedMeta: meta, renderedFrom: renderSource(card) })
    .where(and(eq(cards.headId, headId), eq(cards.id, card.id)));
  return { html: body.html, actions, meta };
}

/** After a PUT commits: render unless this content is already rendered, and never let a failure reach the producer. */
export async function renderAfterCommit(db: Db, headId: string, card: Card): Promise<void> {
  try {
    const [row] = await db.select({ from: cards.renderedFrom }).from(cards).where(and(eq(cards.headId, headId), eq(cards.id, card.id)));
    if (row?.from === renderSource(card)) return;
    await renderCard(db, headId, card);
  } catch (e) {
    console.error(`rendering ${card.id} failed; it is retried on the next read`, e);
  }
}
