// The nightly card's body: a mechanical fold of the head's own records, no language model (CLAUDE.md H2).
// Pure: the cron gathers the cards, this writes the card. RFC 0.6 §8 "What a brief contains": every open decision's
// title and lead, then the title and lead of the newest card of each of the previous day's threads, each linked to
// its card. Counts are one closing line: an addition, never the brief.

import { leadOf, type Card, type ProducerCard } from '@pbcp/core';
import { cutSummary, inlineLead } from '../render/lead';

export interface FoldInput {
  owner: string;
  /** The local date the brief is for (YYYY-MM-DD); "yesterday" is the local day before it. */
  date: string;
  emittedAt: string;
  openDecisions: Card[];
  yesterday: Card[];
  /** The head's own page for a card: an absolute https URL to this head (lib/render keeps it an in-app link). */
  cardUrl: (id: string) => string;
}

/** One line of the brief: a card and what it says. `count` is the size of the thread it stands for. */
export interface FoldLine {
  id: string;
  producer: string;
  title: string;
  /** The lead as markdown for the brief: a summary escaped and cut at 280 characters, a body lead inline (§3.1). */
  lead: string;
  count: number;
  snoozed: boolean;
}

export interface FoldLines {
  decisions: FoldLine[];
  threads: FoldLine[];
  /** "2 open decisions · 14 cards yesterday from 5 producers" */
  counts: string;
}

const MAX_THREADS = 100;
const MAX_TITLE = 120;

/** Producer text is untrusted (§12): escaped so it reads as written and cannot add links or images. */
export function escapeMarkdown(s: string, max = MAX_TITLE): string {
  const short = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return short.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

const longDate = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T00:00:00Z`));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A card's lead as markdown in a brief line: a summary is text (§3.1), so it is escaped; a body lead stays markdown, inline. */
export function leadMarkdown(c: { summary?: string; body: string }): string {
  const lead = leadOf(c);
  return lead.source === 'summary' ? escapeMarkdown(cutSummary(lead.text), Infinity) : inlineLead(lead.text);
}

const line = (c: Card, count = 1): FoldLine => ({ id: c.id, producer: c.producer, title: c.title, lead: leadMarkdown(c), count, snoozed: !!c.snoozed_until });

/** Yesterday's cards collapsed by producer thread, newest thread first; each line is its newest card. */
export function foldThreads(cards: Card[]): FoldLine[] {
  const threads = new Map<string, Card[]>();
  for (const c of [...cards].sort((a, b) => a.change_seq - b.change_seq)) {
    const key = `${c.producer}\u0000${c.thread ?? `\u0001${c.id}`}`;
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  return [...threads.values()].sort((a, b) => b.at(-1)!.change_seq - a.at(-1)!.change_seq).map((cs) => line(cs.at(-1)!, cs.length));
}

export function dailyLines(input: Pick<FoldInput, 'openDecisions' | 'yesterday'>): FoldLines {
  const producers = new Set(input.yesterday.map((c) => c.producer));
  return {
    decisions: input.openDecisions.map((c) => line(c)),
    threads: foldThreads(input.yesterday),
    counts: `${plural(input.openDecisions.length, 'open decision')} · ${plural(input.yesterday.length, 'card')} yesterday from ${plural(producers.size, 'producer')}`,
  };
}

/** "title — lead", the title linked to the card (§8). */
function markdownLine(l: FoldLine, cardUrl: (id: string) => string): string {
  const more = l.count > 1 ? ` (${l.count} in thread)` : '';
  const snoozed = l.snoozed ? ' (snoozed)' : '';
  return `- [${escapeMarkdown(l.title)}](<${cardUrl(l.id)}>)${more}${snoozed}${l.lead ? ` — ${l.lead}` : ''}`;
}

export function foldDaily(input: FoldInput): ProducerCard {
  const { decisions, threads, counts } = dailyLines(input);
  const lines: string[] = [];

  // Every open decision (§8 MUST): no cap.
  if (decisions.length === 0) lines.push('Nothing is waiting for you.');
  for (const l of decisions) lines.push(markdownLine(l, input.cardUrl));
  lines.push('');

  lines.push('**Yesterday**', '');
  if (threads.length === 0) lines.push('No cards arrived yesterday.');
  for (const l of threads.slice(0, MAX_THREADS)) lines.push(markdownLine(l, input.cardUrl));
  if (threads.length > MAX_THREADS) lines.push(`- …and ${threads.length - MAX_THREADS} more threads`);
  lines.push('', counts);

  return {
    protocol: 'pbcp/1',
    id: `head:daily:${input.date}`,
    kind: 'artifact',
    to_person: input.owner,
    producer: 'head',
    thread: 'daily',
    urgency: 'brief',
    title: `Brief for ${longDate(input.date)}`,
    // The head is this card's producer: its lead is the counts (RFC 0.6 `summary`), since the body opens with a list.
    summary: counts,
    references: input.openDecisions.map((c) => c.id),
    emitted_at: input.emittedAt,
    body: lines.join('\n').trimEnd() + '\n',
  };
}
