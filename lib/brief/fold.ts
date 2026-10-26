// The nightly card's body: a mechanical fold of the head's own records, no language model (CLAUDE.md H2).
// Pure: the cron gathers the cards, this writes the card.

import type { Card, ProducerCard } from '@pbcp/core';

export interface FoldInput {
  owner: string;
  /** The local date the brief is for (YYYY-MM-DD); "yesterday" is the local day before it. */
  date: string;
  emittedAt: string;
  openDecisions: Card[];
  yesterday: Card[];
}

const MAX_DECISIONS = 50;
const MAX_THREADS = 100;
const MAX_TITLE = 120;

/** Producer titles are untrusted text (§12): escaped so they read as written and cannot add links or images. */
export function escapeMarkdown(s: string): string {
  const short = s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s;
  return short.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

const longDate = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T00:00:00Z`));
const shortDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(iso));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function foldDaily(input: FoldInput): ProducerCard {
  const { openDecisions, yesterday } = input;
  const byProducer = new Map<string, { decision: number; artifact: number; signal: number }>();
  for (const c of yesterday) {
    const counts = byProducer.get(c.producer) ?? { decision: 0, artifact: 0, signal: 0 };
    counts[c.kind] += 1;
    byProducer.set(c.producer, counts);
  }
  const producers = [...byProducer.entries()].sort(([a, x], [b, y]) => y.decision + y.artifact + y.signal - (x.decision + x.artifact + x.signal) || (a < b ? -1 : 1));

  const lines: string[] = [];
  lines.push(`**${plural(openDecisions.length, 'open decision')}** · ${plural(yesterday.length, 'card')} yesterday from ${plural(producers.length, 'producer')}`, '');

  // The one chart that matters goes first (§3.1 Presentation), in the core tier so every head draws it.
  if (producers.length > 0) {
    lines.push('```mermaid', 'pie title Cards yesterday by producer');
    for (const [p, c] of producers) lines.push(`  "${p}" : ${c.decision + c.artifact + c.signal}`);
    lines.push('```', '');
  }

  lines.push('## Open decisions', '');
  if (openDecisions.length === 0) lines.push('Nothing is waiting for you.');
  for (const c of openDecisions.slice(0, MAX_DECISIONS)) {
    lines.push(`- **${c.producer}** · ${escapeMarkdown(c.title)} — since ${shortDate(c.received_at)}${c.snoozed_until ? ' (snoozed)' : ''}`);
  }
  if (openDecisions.length > MAX_DECISIONS) lines.push(`- …and ${openDecisions.length - MAX_DECISIONS} more`);
  lines.push('');

  lines.push('## Yesterday by producer', '');
  if (producers.length === 0) lines.push('No cards arrived yesterday.');
  else {
    lines.push('| Producer | Decisions | Artifacts | Signals | Total |', '| --- | ---: | ---: | ---: | ---: |');
    for (const [p, c] of producers) lines.push(`| ${p} | ${c.decision} | ${c.artifact} | ${c.signal} | ${c.decision + c.artifact + c.signal} |`);
  }
  lines.push('');

  // Yesterday's log, collapsed by thread: one line per producer thread, newest card named.
  const threads = new Map<string, Card[]>();
  for (const c of [...yesterday].sort((a, b) => a.change_seq - b.change_seq)) {
    const key = `${c.producer}\u0000${c.thread ?? `\u0001${c.id}`}`;
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  if (threads.size > 0) {
    lines.push("## Yesterday's log", '');
    const folds = [...threads.values()].sort((a, b) => b.at(-1)!.change_seq - a.at(-1)!.change_seq);
    for (const cs of folds.slice(0, MAX_THREADS)) {
      const latest = cs.at(-1)!;
      const where = latest.thread ? ` · ${escapeMarkdown(latest.thread)}` : '';
      const count = cs.length > 1 ? `${cs.length} cards, latest ` : '';
      lines.push(`- **${latest.producer}**${where} — ${count}“${escapeMarkdown(latest.title)}” (${latest.kind}${latest.decision ? `, ${latest.decision}` : ''})`);
    }
    if (folds.length > MAX_THREADS) lines.push(`- …and ${folds.length - MAX_THREADS} more threads`);
  }

  return {
    protocol: 'pbcp/1',
    id: `head:daily:${input.date}`,
    kind: 'artifact',
    to_person: input.owner,
    producer: 'head',
    thread: 'daily',
    urgency: 'brief',
    title: `Brief for ${longDate(input.date)}`,
    references: openDecisions.slice(0, MAX_DECISIONS).map((c) => c.id),
    emitted_at: input.emittedAt,
    body: lines.join('\n').trimEnd() + '\n',
  };
}
