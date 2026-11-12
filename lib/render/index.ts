// Render on receipt (RFC §3.1, docs/head-skeleton.md "Rendering pipeline"): a card's body and its choice
// options' bodies become HTML once, server-side, stored beside the card. Diagrams are drawn through a
// cache keyed by sha256 of the sanitised fence. `renderCard` runs after a PUT commits; reads call
// `ensureRendered`, which redraws only what is missing or stale (a failed draw, a newer body).

import { actionId, type Card } from '@pbcp/core';
import { and, eq, sql } from 'drizzle-orm';
import { dataKey } from '../keys';
import { openDiagram, sealDiagram, sealField } from '../vault';
import { createHash } from 'node:crypto';
import type { Db } from '../../db/client';
import { cards, diagrams } from '../../db/schema';
import { drawSvg } from './drawer';
import { DiagramError } from './errors';
import { presentLead, type PresentedLead } from './lead';
import { renderMarkdown, type DiagramOutcome, type Rendered, type Visual } from './markdown';
import { diagramType } from './mermaid';
import { proxiedImageSrc } from './proxy';
import { sanitiseSvg } from './svg';

/** Bump when the pipeline's output changes, so stored renders are redone on next read. */
export const RENDER_VERSION = 'h2.5'; // h2.5: a head's diagrams are its own, sealed, served with ?h= // h2.2: the lead (RFC 0.6 §3.1) is rendered with the body; h2.3: `**bold**` leads stay bold; h2.4: a list or quote lead loses its marker

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const g = globalThis as unknown as { __pbcpDraws?: number };
/** Diagrams drawn (cache misses) in this process, for the conformance suite's R07. */
export const drawCount = (): number => g.__pbcpDraws ?? 0;
export const resetDrawCount = (): void => void (g.__pbcpDraws = 0);

/**
 * The fence drawn for a dark page too, stored beside the light drawing. A refusal is kept (the light one is served
 * instead); an infrastructure failure is not, so the next render of a card with this fence tries again. Not counted
 * in drawCount, which is the pipeline's one drawing per fence (R07).
 */
/**
 * At rest (lib/vault.ts): a head's diagrams are its content, sealed under its data key, so the cache is per head: the
 * row's key is the fence's hash scoped to the head (sha256 of "<head>:<fence hash>"), and the drawing's address names the
 * head (`?h=`), whose key the route opens it with. The front door's demo (no head) draws into public rows, in clear.
 */
export const scopedHash = (headId: string | null, fenceHash: string) => (headId === null ? fenceHash : sha256(`${headId}:${fenceHash}`));

/** Where a drawing is served from: the head's own, or (the demo) the public one. */
export const svgSrc = (headId: string | null) => (hash: string) => (headId === null ? `/api/me/svg/${hash}` : `/api/me/svg/${hash}?h=${encodeURIComponent(headId)}`);

type Drawn = { svg: string | null; svgDark: string | null; error: string | null; errorDark: string | null };

async function readDiagram(db: Db, headId: string | null, hash: string): Promise<Drawn | null> {
  const [row] = await db.select().from(diagrams).where(eq(diagrams.hash, hash));
  if (!row) return null;
  return openDiagram(row, headId === null ? null : await dataKey(db, headId), headId);
}

async function writeDiagram(db: Db, headId: string | null, hash: string, type: string, d: Partial<Drawn>, update = false): Promise<void> {
  const key = headId === null ? null : await dataKey(db, headId, { create: true });
  const content = sealDiagram(key, headId, hash, d);
  if (update) await db.update(diagrams).set({ content: sql`coalesce(${diagrams.content}, '{}'::jsonb) || ${JSON.stringify(content)}::jsonb` }).where(eq(diagrams.hash, hash));
  else await db.insert(diagrams).values({ hash, type, content }).onConflictDoNothing();
}

async function drawDark(db: Db, headId: string | null, hash: string, source: string, fenceHash: string): Promise<void> {
  try {
    const svgDark = sanitiseSvg(await drawSvg(source, `d${fenceHash.slice(0, 12)}`, 'dark'), { allowStyle: true });
    await writeDiagram(db, headId, hash, '', { svgDark }, true);
  } catch (e) {
    if (e instanceof DiagramError) await writeDiagram(db, headId, hash, '', { errorDark: e.message }, true);
    else console.error(`drawing ${hash} for a dark page failed; it is retried on the next render`, e);
  }
}

/** The diagram dependency of the markdown renderer: cached per head, drawn on a miss, in both page themes. */
export function cachedDiagrams(db: Db, headId: string | null = null) {
  return async (source: string): Promise<DiagramOutcome> => {
    const fenceHash = sha256(source);
    const hash = scopedHash(headId, fenceHash);
    const hit = await readDiagram(db, headId, hash);
    if (hit) {
      // Drawn before dark drawings existed, or a dark drawing that failed for want of a browser: draw it now.
      if (hit.svg !== null && hit.svgDark === null && hit.errorDark === null) await drawDark(db, headId, hash, source, fenceHash);
      return hit.svg !== null ? { status: 'render', hash } : { status: 'fallback', message: hit.error ?? 'diagram could not be drawn' };
    }
    g.__pbcpDraws = drawCount() + 1;
    let drawn: Partial<Drawn>;
    try {
      // A stable id from the fence's hash keeps the drawing identical across draws (§3.1 Determinism).
      drawn = { svg: sanitiseSvg(await drawSvg(source, `d${fenceHash.slice(0, 12)}`), { allowStyle: true }) };
    } catch (e) {
      if (!(e instanceof DiagramError)) throw e; // infrastructure: do not cache, let the next read retry
      drawn = { error: e.message };
    }
    await writeDiagram(db, headId, hash, diagramType(source), drawn);
    if (drawn.svg) await drawDark(db, headId, hash, source, fenceHash);
    return drawn.svg ? { status: 'render', hash } : { status: 'fallback', message: drawn.error! };
  };
}

/** A diagram's drawings for the route, opened with the head's key (or the public ones). */
export async function servedDiagram(db: Db, headId: string | null, hash: string): Promise<Drawn | null> {
  return readDiagram(db, headId, hash);
}

export function renderBody(db: Db, body: string, headId: string | null = null): Promise<Rendered> {
  return renderMarkdown(body, { diagram: cachedDiagrams(db, headId), imageSrc: proxiedImageSrc, svgSrc: svgSrc(headId) });
}

export interface RenderMeta {
  firstVisual: Visual | null;
  /** The card's lead (§3.1): core's leadOf, presented (lib/render/lead.ts). Absent on renders before h2.2. */
  lead?: PresentedLead;
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
export const renderSource = (card: Card): string => sha256(JSON.stringify([RENDER_VERSION, card.body, optionBodies(card), card.summary ?? null]));

/** Renders a card's body and option bodies and stores them beside it. */
export async function renderCard(db: Db, headId: string, card: Card): Promise<CardRender> {
  const { html, actions, meta } = await renderCardContent(db, card, headId);
  // At rest: the rendered output sealed into the card's content (lib/vault.ts); what it was rendered from stays clear.
  const key = await dataKey(db, headId, { create: true });
  if (!key) return { html, actions, meta }; // the head is gone (deleted while this rendered): nothing to store
  const sealed = { html: sealField(key, headId, card.id, 'html', html), actions: sealField(key, headId, card.id, 'actions', actions), meta: sealField(key, headId, card.id, 'meta', meta) };
  await db
    .update(cards)
    .set({ content: sql`coalesce(${cards.content}, '{"v":1}'::jsonb) || ${JSON.stringify(sealed)}::jsonb`, renderedFrom: renderSource(card) })
    .where(and(eq(cards.headId, headId), eq(cards.id, card.id)));
  return { html, actions, meta };
}

/**
 * A card's body, option bodies and lead through the pipeline, stored nowhere (the diagram cache aside): renderCard
 * keeps the result on the card's row; the front door's demo brief (lib/demo) shows it and keeps nothing.
 */
export async function renderCardContent(db: Db, card: Card, headId: string | null = null): Promise<CardRender> {
  const body = await renderBody(db, card.body, headId);
  const actions: Record<string, string> = {};
  for (const [id, md] of optionBodies(card)) actions[id] = (await renderBody(db, md, headId)).html;
  const lead = await presentLead(card, async (md) => (await renderBody(db, md, headId)).html);
  const meta: RenderMeta = { firstVisual: body.firstVisual, lead, fences: body.result.fences.map((f) => ({ type: f.type, class: f.class })) };
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
