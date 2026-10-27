// The nightly card's body: a mechanical fold of the head's own records, no language model (CLAUDE.md H2).
// Pure: the cron gathers the cards, this writes the card. RFC 0.6 §8 "What a brief contains": every open decision's
// title and lead, then the title and lead of the newest card of each of the previous day's threads, each linked to
// its card. The body opens with the daily paragraph, prose made of those titles and leads and nothing else
// ("2 decisions: <title> — <lead>; …. Yesterday: …."; snoozed decisions are counted, never listed: §8, §4.2), which
// is therefore the card's own lead (§3.1); the entries follow, and the counts close it.
// A day with nothing open and nothing new has no paragraph and no card.

import { leadOf, type Card, type ProducerCard } from '@pbcp/core';
import { cutSummary, inlineLead } from '../render/lead';
import { FOLD_FIELD, FOLD_VERSION } from './fold-version';

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
  /** The lead as a phrase for the daily paragraph: link-free inline markdown, no closing stop; empty when the lead is empty or only repeats the title. */
  phrase: string;
  count: number;
  snoozed: boolean;
}

export interface FoldLines {
  /** Every open decision, snoozed ones included (marked), for the count; only the unsnoozed are listed. */
  decisions: FoldLine[];
  /** The previous day's threads, each by its newest card that is not snoozed; a thread snoozed throughout is left out. */
  threads: FoldLine[];
  /** "2 open decisions, 1 snoozed · 14 cards yesterday from 5 producers" */
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

/**
 * A lead inside the daily paragraph, after its card's linked title: its own links and images unwrapped (the paragraph's
 * links are to cards), no closing stop. Empty when there is no lead or it says only the title again.
 */
function phrase(c: Card): string {
  // The closing stop goes before escaping: an escaped one would leave a backslash in front of the entry's separator.
  const stop = (s: string) => s.replace(/[\s.;:,]+$/, '').trim();
  const lead = leadOf(c);
  if (stop(lead.text) === stop(c.title)) return '';
  const md =
    lead.source === 'summary'
      ? escapeMarkdown(stop(cutSummary(lead.text)), Infinity)
      : stop(inlineLead(lead.text).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
  return md;
}

const line = (c: Card, at: string, count = 1): FoldLine => ({
  id: c.id,
  producer: c.producer,
  title: c.title,
  lead: leadMarkdown(c),
  phrase: phrase(c),
  count,
  // Snoozed now: a snooze that has run out leaves the decision open like any other (§4.2 `snoozed_until`).
  snoozed: !!c.snoozed_until && Date.parse(c.snoozed_until) > Date.parse(at),
});

/**
 * Yesterday's cards collapsed by producer thread, newest thread first. Each line is the thread's newest card that is
 * not snoozed, and a thread whose cards are all snoozed is left out (§8: no snoozed card or its lead in a brief).
 */
export function foldThreads(cards: Card[], at: string): FoldLine[] {
  const threads = new Map<string, Card[]>();
  for (const c of [...cards].sort((a, b) => a.change_seq - b.change_seq)) {
    const key = `${c.producer}\u0000${c.thread ?? `\u0001${c.id}`}`;
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  return [...threads.values()]
    .map((cs) => ({ shown: cs.map((c) => line(c, at, cs.length)).filter((l) => !l.snoozed).at(-1), last: cs.at(-1)!.change_seq }))
    .filter((t): t is { shown: FoldLine; last: number } => t.shown !== undefined)
    .sort((a, b) => b.last - a.last)
    .map((t) => t.shown);
}

/** `at` is now: a decision whose `snoozed_until` is later is snoozed. */
export function dailyLines(input: Pick<FoldInput, 'openDecisions' | 'yesterday'> & { at: string }): FoldLines {
  const producers = new Set(input.yesterday.map((c) => c.producer));
  const decisions = input.openDecisions.map((c) => line(c, input.at));
  return {
    decisions,
    threads: foldThreads(input.yesterday, input.at),
    counts: `${decisionCount(decisions, 'open decision')} · ${plural(input.yesterday.length, 'card')} yesterday from ${plural(producers.size, 'producer')}`,
  };
}

/** "4 decisions" or, when any are snoozed, "4 decisions, 1 snoozed": a snoozed decision is not counted among the rest. */
function decisionCount(decisions: FoldLine[], noun: string): string {
  const snoozed = decisions.filter((l) => l.snoozed).length;
  const awake = plural(decisions.length - snoozed, noun);
  return snoozed > 0 ? `${awake}, ${snoozed} snoozed` : awake;
}

/** "title — lead", the title linked to the card (§8). */
function markdownLine(l: FoldLine, cardUrl: (id: string) => string): string {
  const more = l.count > 1 ? ` (${l.count} in thread)` : '';
  return `- [${escapeMarkdown(l.title)}](<${cardUrl(l.id)}>)${more}${l.lead ? ` — ${l.lead}` : ''}`;
}

/**
 * The daily paragraph (markdown): "N decisions: <title> — <lead>; <title> — <lead>." then "Yesterday: <title> —
 * <lead>; …." (§8: each entry its card's title and lead), each title a link to its card; an entry whose lead is empty
 * or repeats the title is the title alone. A weak lead ("From: Jonas Holm …") still has its title beside it. Snoozed decisions are counted apart and not listed: "4 decisions, 1 snoozed: <lead>; …."; when
 * every open decision is snoozed, "0 decisions, 2 snoozed." Empty when nothing is open and nothing arrived the day
 * before: no sentence for its own sake.
 */
export function dailyParagraph(lines: Pick<FoldLines, 'decisions' | 'threads'>, cardUrl: (id: string) => string): string {
  const link = (l: FoldLine) => `[${escapeMarkdown(l.title)}](<${cardUrl(l.id)}>)${l.phrase ? ` — ${l.phrase}` : ''}`;
  const sentences: string[] = [];
  const awake = lines.decisions.filter((l) => !l.snoozed);
  if (lines.decisions.length > 0) sentences.push(`${decisionCount(lines.decisions, 'decision')}${awake.length ? `: ${awake.map(link).join('; ')}` : ''}.`);
  if (lines.threads.length > 0) sentences.push(`Yesterday: ${lines.threads.slice(0, MAX_THREADS).map(link).join('; ')}.`);
  return sentences.join(' ');
}

/** The nightly card, or null for a day with nothing open and nothing new (no card says nothing). */
export function foldDaily(input: FoldInput): ProducerCard | null {
  // The fold is as of when it is emitted: a decision snoozed past then is snoozed in it.
  const { decisions, threads, counts } = dailyLines({ ...input, at: input.emittedAt });
  const paragraph = dailyParagraph({ decisions, threads }, input.cardUrl);
  if (!paragraph) return null;
  const lines: string[] = [paragraph, ''];

  // Every open decision that is not snoozed (§8 MUST): no cap. A snoozed one is only counted (§8, §4.2).
  const awake = decisions.filter((l) => !l.snoozed);
  if (awake.length === 0) lines.push('Nothing is waiting for you.');
  for (const l of awake) lines.push(markdownLine(l, input.cardUrl));
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
    references: input.openDecisions.map((c) => c.id),
    [FOLD_FIELD]: FOLD_VERSION,
    emitted_at: input.emittedAt,
    body: lines.join('\n').trimEnd() + '\n',
  };
}
