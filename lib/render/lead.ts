// The lead as the head shows it (RFC 0.6 §3.1 "Lead"). Which text is the lead is core's `leadOf`; this module only
// presents it: a `summary` as text, cut for display at SUMMARY_DISPLAY_MAX (§4.1: "a head MAY truncate"); a body
// lead as inline markdown, rendered by the same pipeline and sanitiser as bodies.

import { leadOf, type Lead } from '@pbcp/core';

/** §4.1: a summary SHOULD be under 280 characters; a longer one is cut here, at a word, for display. */
export const SUMMARY_DISPLAY_MAX = 280;

export function cutSummary(s: string, max = SUMMARY_DISPLAY_MAX): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const word = head.lastIndexOf(' ');
  return `${(word > max * 0.6 ? head.slice(0, word) : head).replace(/[\s,;:.–—-]+$/, '')}…`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);

/**
 * A body lead's markdown as one inline line: its lines joined by a space, and a leading block marker (a list
 * item, a quotation, a table row: §3.1 lets the lead's first line be one) escaped, so it renders as text in a
 * line, not as a list or a quotation.
 */
export function inlineLead(text: string): string {
  return text
    .split('\n')
    .join(' ')
    .replace(/^(\s*)([-*+>|])/, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)])/, '$1\\$2');
}

export interface PresentedLead extends Lead {
  /** Safe HTML for the lead, inline (no wrapping paragraph). */
  html: string;
}

/** `renderInline` renders one line of markdown to sanitised HTML wrapped in a paragraph (lib/render renderBody). */
export async function presentLead(card: { summary?: string; body: string }, renderInline: (md: string) => Promise<string>): Promise<PresentedLead> {
  const lead = leadOf(card);
  if (lead.source === 'summary') return { ...lead, html: escapeHtml(cutSummary(lead.text)) };
  if (lead.text === '') return { ...lead, html: '' };
  const html = (await renderInline(inlineLead(lead.text))).trim();
  return { ...lead, html: html.replace(/^<p>([\s\S]*)<\/p>$/, '$1') };
}
