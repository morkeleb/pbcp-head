// The nightly card's body: a mechanical fold of the head's own records, no language model (CLAUDE.md H2).
// Pure: the cron gathers the cards, this writes the card. The brief is the cards' leads (lib/lead.ts): what is
// waiting for the owner, then what yesterday's threads said. Counts are one closing line; §8 makes counts and
// charts additions to a brief, never the brief itself.

import type { Card, ProducerCard } from '@pbcp/core';
import { leadOf } from '../lead';

export interface FoldInput {
  owner: string;
  /** The local date the brief is for (YYYY-MM-DD); "yesterday" is the local day before it. */
  date: string;
  emittedAt: string;
  openDecisions: Card[];
  yesterday: Card[];
  /** The head's own page for a card, an absolute https URL (lib/render keeps links to its own origin in-app). */
  cardUrl: (id: string) => string;
}

/** One line of the brief: a card and what it says. `count` is the size of the thread it stands for. */
export interface FoldLine {
  id: string;
  producer: string;
  title: string;
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

const MAX_DECISIONS = 50;
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

const line = (c: Card, count = 1): FoldLine => ({ id: c.id, producer: c.producer, title: c.title, lead: leadOf(c), count, snoozed: !!c.snoozed_until });

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

function markdownLine(l: FoldLine, cardUrl: (id: string) => string): string {
  const more = l.count > 1 ? ` (${l.count} in thread)` : '';
  const snoozed = l.snoozed ? ' (snoozed)' : '';
  const lead = l.lead ? ` — ${escapeMarkdown(l.lead, Infinity)}` : '';
  return `- **${escapeMarkdown(l.producer)}** · [${escapeMarkdown(l.title)}](<${cardUrl(l.id)}>)${more}${snoozed}${lead}`;
}

export function foldDaily(input: FoldInput): ProducerCard {
  const { decisions, threads, counts } = dailyLines(input);
  const lines: string[] = [];

  if (decisions.length === 0) lines.push('Nothing is waiting for you.');
  for (const l of decisions.slice(0, MAX_DECISIONS)) lines.push(markdownLine(l, input.cardUrl));
  if (decisions.length > MAX_DECISIONS) lines.push(`- …and ${decisions.length - MAX_DECISIONS} more`);
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
    references: input.openDecisions.slice(0, MAX_DECISIONS).map((c) => c.id),
    emitted_at: input.emittedAt,
    body: lines.join('\n').trimEnd() + '\n',
  };
}
