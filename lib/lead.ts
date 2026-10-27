// A card's lead: what the head shows on the card, before any gesture, beside its actions. RFC 0.6 is adding a
// producer-owned `summary` (one or two plain-text sentences) with the rule that the lead is `summary` when
// present and otherwise the body's first paragraph. Until @pbcp/core 0.7 provides `leadOf`, this is the
// head's local copy of that rule; `summary` arrives as a preserved unknown producer field (§3.1 "Unknown
// fields"). When core 0.7 lands, switch to its `leadOf` and delete this file.

import type { BlockContent, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** A lead taken from the body is cut here, at a word, with an ellipsis. A `summary` is the producer's and is not cut. */
export const LEAD_MAX = 200;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The producer's `summary`: plain text, never markdown. Undefined when absent or blank. */
export function summaryOf(card: object): string | undefined {
  const s = (card as { summary?: unknown }).summary;
  return typeof s === 'string' && collapse(s) !== '' ? collapse(s) : undefined;
}

function text(node: RootContent | PhrasingContent | BlockContent | Root): string {
  if ('value' in node && typeof node.value === 'string') return node.type === 'html' ? '' : node.value;
  if (node.type === 'break') return ' ';
  if (node.type === 'image') return node.alt ?? '';
  const parts = 'children' in node ? (node.children as Array<RootContent>).map(text) : [];
  // Block children (list items, quoted paragraphs) read as one line, separated.
  return node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote' ? parts.join(' ') : parts.join('');
}

/**
 * The body's first paragraph as plain text. A body with no paragraph at top level (a mail card's `- From:` list
 * and quoted text) falls back to its first list or quotation; headings, code, diagrams and tables never lead.
 */
export function firstParagraph(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const paragraph = tree.children.find((n): n is Paragraph => n.type === 'paragraph' && collapse(text(n)) !== '');
  const block = paragraph ?? tree.children.find((n) => (n.type === 'list' || n.type === 'blockquote') && collapse(text(n)) !== '');
  return block ? collapse(text(block)) : '';
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const word = head.lastIndexOf(' ');
  return `${(word > max * 0.6 ? head.slice(0, word) : head).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** The lead as plain text: `summary`, else the body's first paragraph cut at LEAD_MAX. */
export function leadOf(card: { body: string }): string {
  return summaryOf(card) ?? cut(firstParagraph(card.body), LEAD_MAX);
}
