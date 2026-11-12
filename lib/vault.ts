// What is encrypted at rest, and how a row is opened again (docs/trust.md "At rest"). One rule: content is encrypted,
// the metadata the head needs to route, order and sync is not. Each table keeps its sealed content in one `content`
// JSON, so there is one place to forget.
//
//   cards          sealed: the producer document minus its clear fields (title, summary, body, labels, source, actions,
//                  any unknown field), the decided-on document, the rendered HTML, option bodies, meta (lead, first
//                  visual), the daily paragraph's parts, the owner's comment and edited proposal.
//                  clear (producer_doc and columns): protocol, id, kind, to_person, producer, urgency, sensitivity,
//                  thread, about, at, until, references, supersedes, emitted_at, orders.*, and every head column.
//   decision_log   sealed: the decided-on document, comment, edited proposal. clear: card id, value, device, time.
//   diagrams       sealed: svg, svg_dark, error, error_dark. clear: the hash (scoped to the head), the diagram type.
//   invite_requests sealed: the email. clear: a keyed digest of it, time, user agent.
//
// Labels are sealed (a producer's words about the person's life); thread ids are opaque keys and stay clear; at and
// about stay clear (the schedule, the day query and the week strip are indexes over them); the decision value stays
// clear (producers read it through sync, and the conformance suite asserts it).
//
// Every row is in this form: migration 0024 dropped the plaintext columns once every row was sealed.

import type { ProducerCard } from '@pbcp/core';
import type { cards, decisionLog } from '../db/schema';
import { canonicalJson, digest, isSealed, open, seal } from './crypto';

type CardRow = typeof cards.$inferSelect;
type LogRow = typeof decisionLog.$inferSelect;

/** A card's sealed content opened: what the rest of the head reads, in memory only (never a column). */
export interface OpenFields {
  renderedHtml: string | null;
  renderedActions: unknown;
  renderedMeta: unknown;
  renderedParagraph: unknown;
  comment: string | null;
  editedProposal: string | null;
}

/** A cards row with its content opened (`openCardRow`). */
export type OpenCardRow = CardRow & OpenFields;

/** Producer fields the head reads in queries, routes and orders by: kept in clear in producer_doc. */
export const CLEAR_FIELDS = new Set([
  'protocol', 'id', 'kind', 'to_person', 'producer', 'urgency', 'sensitivity', 'thread', 'about', 'at', 'until', 'references',
  'supersedes', 'emitted_at', 'orders.claim_seq', 'orders.result',
]);

/** The clear part of a producer document, and the rest. */
export function splitDoc(doc: Record<string, unknown>): { clear: Record<string, unknown>; secret: Record<string, unknown> } {
  const clear: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) (CLEAR_FIELDS.has(k) ? clear : secret)[k] = v;
  return { clear, secret };
}

/** A card's sealed content, as stored in cards.content. Every value but `v` and `mac` is a sealed string. */
export interface CardContent {
  v: 1;
  /** A keyed digest of the whole producer document: equality (the day a card keeps, §5 checks) without reading it. */
  mac?: string;
  doc?: string;
  decided?: string;
  html?: string;
  actions?: string;
  meta?: string;
  paragraph?: string;
  comment?: string;
  edited?: string;
}

const COL = { doc: 'cards.doc', decided: 'cards.decided_doc', html: 'cards.rendered_html', actions: 'cards.rendered_actions', meta: 'cards.rendered_meta', paragraph: 'cards.rendered_paragraph', comment: 'cards.comment', edited: 'cards.edited_proposal' } as const;

/** The keyed digest of a producer document (canonical JSON). */
export const docMac = (key: Buffer, doc: ProducerCard | Record<string, unknown>) => digest(key, 'cards.doc', canonicalJson(doc));

/**
 * A producer document as stored: the clear part for producer_doc, and the sealed rest with its digest. Every field of
 * cards.content is bound to its card (`cardId`, the row's id): copied to another card's row, it does not open.
 */
export function sealDoc(key: Buffer, headId: string, cardId: string, doc: ProducerCard | Record<string, unknown>): { clear: Record<string, unknown>; doc: string; mac: string } {
  const { clear, secret } = splitDoc(doc as Record<string, unknown>);
  return { clear, doc: seal(key, headId, COL.doc, cardId, JSON.stringify(secret)), mac: docMac(key, doc) };
}

/** Seals one JSON-able value (or a string) for a field of one card's cards.content. */
export function sealField(key: Buffer, headId: string, cardId: string, field: keyof typeof COL, value: unknown): string {
  return seal(key, headId, COL[field], cardId, typeof value === 'string' && (field === 'html' || field === 'comment' || field === 'edited') ? value : JSON.stringify(value));
}

function openField<T>(key: Buffer, headId: string, cardId: string, field: keyof typeof COL, sealed: string): T {
  const s = open(key, headId, COL[field], cardId, sealed);
  return (field === 'html' || field === 'comment' || field === 'edited' ? s : JSON.parse(s)) as T;
}

/**
 * A cards row with its sealed content opened: producer_doc whole again, decided_doc, the rendered output, comment and
 * edited proposal. Throws CryptoError when a sealed value does not authenticate: the caller decides whether that card
 * is left out (the brief) or the request fails.
 */
export function openCardRow(row: CardRow, key: Buffer | null): OpenCardRow {
  const out: OpenCardRow = { ...row, renderedHtml: null, renderedActions: null, renderedMeta: null, renderedParagraph: null, comment: null, editedProposal: null };
  const c = row.content as CardContent | null;
  if (!c) return out;
  if (!key) throw new Error(`card ${row.id} is sealed and its head has no data key`);
  if (c.doc) out.producerDoc = { ...(openField<Record<string, unknown>>(key, row.headId, row.id, 'doc', c.doc)), ...(row.producerDoc as Record<string, unknown>) };
  if (c.decided) out.decidedDoc = { ...(openField<Record<string, unknown>>(key, row.headId, row.id, 'decided', c.decided)), ...((row.decidedDoc ?? {}) as Record<string, unknown>) };
  if (c.html) out.renderedHtml = openField(key, row.headId, row.id, 'html', c.html);
  if (c.actions) out.renderedActions = openField(key, row.headId, row.id, 'actions', c.actions);
  if (c.meta) out.renderedMeta = openField(key, row.headId, row.id, 'meta', c.meta);
  if (c.paragraph) out.renderedParagraph = openField(key, row.headId, row.id, 'paragraph', c.paragraph);
  if (c.comment) out.comment = openField(key, row.headId, row.id, 'comment', c.comment);
  if (c.edited) out.editedProposal = openField(key, row.headId, row.id, 'edited', c.edited);
  return out;
}

/** Whether a cards row lacks its sealed document (a row migration 0024 would have refused): --verify's count. */
export const cardUnsealed = (row: Pick<CardRow, 'content'>): boolean => {
  const c = row.content as CardContent | null;
  return !c?.doc || !c.mac;
};

// --- decision_log -------------------------------------------------------------------------------------------------

export interface LogContent {
  doc?: string;
  comment?: string;
  edited?: string;
}

/** A decision-log row's content, bound to the row (`seq`, its id). */
export function sealLog(key: Buffer, headId: string, seq: number, entry: { decidedDoc: Record<string, unknown>; comment: string | null; editedProposal: string | null }): { clearDoc: Record<string, unknown>; content: LogContent } {
  const { clear, secret } = splitDoc(entry.decidedDoc);
  const row = String(seq);
  return {
    clearDoc: clear,
    content: {
      doc: seal(key, headId, 'decision_log.decided_doc', row, JSON.stringify(secret)),
      ...(entry.comment !== null ? { comment: seal(key, headId, 'decision_log.comment', row, entry.comment) } : {}),
      ...(entry.editedProposal !== null ? { edited: seal(key, headId, 'decision_log.edited_proposal', row, entry.editedProposal) } : {}),
    },
  };
}

/** A decision-log row with its content opened: the decided-on document whole again (when selected), comment and edited proposal. */
export function openLogRow<T extends Pick<LogRow, 'headId' | 'seq'> & { content?: unknown; decidedDoc?: unknown }>(row: T, key: Buffer | null): T & { comment: string | null; editedProposal: string | null } {
  const c = row.content as LogContent | null | undefined;
  if (!c) return { ...row, comment: null, editedProposal: null };
  if (!key) throw new Error('a decision-log row is sealed and its head has no data key');
  const id = String(row.seq);
  return {
    ...row,
    comment: null,
    editedProposal: null,
    ...(c.doc && row.decidedDoc !== undefined ? { decidedDoc: { ...JSON.parse(open(key, row.headId, 'decision_log.decided_doc', id, c.doc)), ...(row.decidedDoc as Record<string, unknown>) } } : {}),
    ...(c.comment ? { comment: open(key, row.headId, 'decision_log.comment', id, c.comment) } : {}),
    ...(c.edited ? { editedProposal: open(key, row.headId, 'decision_log.edited_proposal', id, c.edited) } : {}),
  };
}

// --- diagrams -----------------------------------------------------------------------------------------------------

export interface DiagramContent {
  /** The front door's demo: public by design, kept in clear. */
  public?: true;
  svg?: string;
  svgDark?: string;
  error?: string;
  errorDark?: string;
}

type DiagramFields = { svg: string | null; svgDark: string | null; error: string | null; errorDark: string | null };

/** A diagram's drawings, sealed for the head and bound to the row (`hash`, the head-scoped hash), or in clear for the public demo (headId null). */
export function sealDiagram(key: Buffer | null, headId: string | null, hash: string, d: Partial<DiagramFields>): DiagramContent {
  const out: DiagramContent = headId === null ? { public: true } : {};
  for (const k of ['svg', 'svgDark', 'error', 'errorDark'] as const) {
    const v = d[k];
    if (v === null || v === undefined) continue;
    out[k] = headId === null ? v : seal(key!, headId, `diagrams.${k}`, hash, v);
  }
  return out;
}

/** A diagram's drawings in clear, from its content. */
export function openDiagram(row: { content: unknown; hash: string }, key: Buffer | null, headId: string | null): DiagramFields {
  const c = (row.content ?? {}) as DiagramContent;
  const get = (k: keyof DiagramFields) => {
    const v = c[k];
    if (v === undefined) return null;
    if (c.public || !isSealed(v)) return v;
    if (!key || !headId) throw new Error('a sealed diagram needs its head’s key');
    return open(key, headId, `diagrams.${k}`, row.hash, v);
  };
  return { svg: get('svg'), svgDark: get('svgDark'), error: get('error'), errorDark: get('errorDark') };
}
