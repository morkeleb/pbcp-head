import type { Card } from '@pbcp/core';
import { parseCard } from '@pbcp/core';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { dailyLines, dailyParagraph, escapeMarkdown, foldDaily } from '../lib/brief/fold';

let seq = 0;
function stored(id: string, extra: Partial<Card> = {}): Card {
  const producer = id.split(':')[0]!;
  return {
    protocol: 'pbcp/1', id, kind: 'artifact', to_person: 'morten', producer, title: `Title ${id}`, body: 'x',
    emitted_at: '2026-10-06T06:00:00Z', state: 'open', change_seq: ++seq, received_at: '2026-10-06T08:00:00Z', changed_at: '2026-10-06T08:00:00Z',
    ...extra,
  } as Card;
}

describe('the nightly fold', () => {
  const input = {
    owner: 'morten',
    date: '2026-10-07',
    emittedAt: '2026-10-07T03:30:00Z',
    cardUrl: (id: string) => `https://head.example/card/${encodeURIComponent(id)}`,
    openDecisions: [
      stored('hermes:gmail:1', { kind: 'decision', title: 'Reply to Anna re [invoice](https://evil.example)', body: '## Evidence\n\nAnna asks whether the invoice can wait until the **20th**.\n\n## Proposed reply\n\n> Fine.' }),
      stored('goalpath:item:9', { kind: 'decision', snoozed_until: '2026-10-08T03:30:00Z', summary: 'GP-9 is finished; accept it?' } as Partial<Card>),
    ],
    yesterday: [
      stored('hermes:gmail:a', { thread: 'gmail:t1' }),
      stored('hermes:gmail:b', { kind: 'signal', thread: 'gmail:t1', title: 'Sent', body: 'The reply went out at 09:12.' }),
      stored('hermes:gmail:1', { kind: 'decision' }),
      stored('goalpath:item:9', { kind: 'decision', decision: 'approve', state: 'decided', body: '- **From:** Jonas\n- Date: today\n\n> Can you join?' }),
      stored('mail:inbox:7', { summary: 'A very long summary. '.repeat(20).trim() } as Partial<Card>),
    ],
  };

  const fold = (i = input) => foldDaily(i)!;
  const entries = (body: string) => body.split('\n').filter((l) => l.startsWith('- '));

  it('is a valid artifact card under head:daily, brief urgency, referencing the open decisions', () => {
    const card = fold();
    expect(parseCard(card).ok).toBe(true);
    expect(card).toMatchObject({ id: 'head:daily:2026-10-07', kind: 'artifact', urgency: 'brief', producer: 'head', thread: 'daily', title: 'Brief for Wednesday 7 October', references: ['hermes:gmail:1', 'goalpath:item:9'] });
    expect(card).not.toHaveProperty('summary'); // its lead is its opening paragraph
  });

  it('opens with the daily paragraph: the decisions’ leads, then one sentence of yesterday’s, each linked, nothing else', () => {
    const [paragraph] = fold().body.split('\n');
    expect(paragraph).toMatch(
      /^1 decision, 1 snoozed: \[Anna asks whether the invoice can wait until the \*\*20th\*\*\]\(<https:\/\/head\.example\/card\/hermes%3Agmail%3A1>\)\. Yesterday: \[/,
    );
    expect(paragraph).toMatch(/\.$/);
    expect(paragraph).toContain('[The reply went out at 09:12](<https://head.example/card/hermes%3Agmail%3Ab>)');
    // A lead's own links are unwrapped inside the paragraph, where the lead is already a link.
    const withLink = fold({ ...input, yesterday: [stored('cal:x:1', { body: 'Moved to [Room 3](https://rooms.example/3) at 10.' })] });
    expect(withLink.body.split('\n')[0]).toContain('Yesterday: [Moved to Room 3 at 10](<https://head.example/card/cal%3Ax%3A1>).');
  });

  it('then lists every open decision as "title — lead", linked: a summary as text, a body lead as inline markdown', () => {
    const lines = entries(fold().body);
    expect(lines[0]).toBe('- [Reply to Anna re \\[invoice\\]\\(https://evil\\.example\\)](<https://head.example/card/hermes%3Agmail%3A1>) — Anna asks whether the invoice can wait until the **20th**.');
    expect(lines[1]).toBe('- [Title goalpath:item:9](<https://head.example/card/goalpath%3Aitem%3A9>) (snoozed) — GP\\-9 is finished; accept it?');
    const many = Array.from({ length: 70 }, (_, i) => stored(`hermes:gmail:m${i}`, { kind: 'decision' }));
    expect(entries(fold({ ...input, openDecisions: many }).body).filter((l) => l.startsWith('- [Title hermes:gmail:m'))).toHaveLength(70); // every one
  });

  it('then the previous day’s threads by their newest card’s lead', () => {
    const { body } = fold();
    expect(body).toContain('**Yesterday**');
    expect(body).toContain('- [Sent](<https://head.example/card/hermes%3Agmail%3Ab>) (2 in thread) — The reply went out at 09:12.');
    expect(body).toMatch(/— \*\*From:\*\* Jonas\n/); // a list-item lead (its first line, §3.1), inline, without its marker
    const cut = entries(body).find((l) => l.includes('mail%3Ainbox%3A7'))!.split(' — ')[1]!;
    expect(cut.length).toBeLessThanOrEqual(280 + 10);
    expect(cut).toMatch(/…$/);
  });

  it('ends with the counts on one line, and draws no chart', () => {
    const { body } = fold();
    expect(body.trimEnd().split('\n').at(-1)).toBe('1 open decision, 1 snoozed · 5 cards yesterday from 3 producers');
    expect(body).not.toContain('```mermaid');
  });

  it('escapes producer titles so they cannot add links or images', () => {
    expect(escapeMarkdown('![x](y) <b>')).toBe('\\!\\[x\\]\\(y\\) \\<b\\>');
  });

  it('keeps every lead in the paragraph a well-formed link, however the lead ends', () => {
    const ends = ['Ends with a stop.', 'Ends with a colon:', 'Ends (with a bracket)', 'Ends with \\'].map((summary, i) => stored(`mail:x:${i}`, { kind: 'decision', summary } as Partial<Card>));
    const [paragraph] = fold({ ...input, openDecisions: ends }).body.split('\n');
    // What a markdown parser finds: one link per lead, each to its card (4 decisions + yesterday's 4 threads).
    const links: string[] = [];
    const walk = (n: { type: string; url?: string; children?: unknown[] }) => {
      if (n.type === 'link') links.push(n.url!);
      for (const c of (n.children ?? []) as Array<typeof n>) walk(c);
    };
    walk(unified().use(remarkParse).parse(paragraph!) as never);
    expect(links).toHaveLength(8);
    expect(links.every((u) => u.startsWith('https://head.example/card/'))).toBe(true);
  });

  it('counts a snoozed decision apart and leaves it out of the paragraph, but not out of the entries', () => {
    const decisions = [
      ...Array.from({ length: 4 }, (_, i) => stored(`mail:d:${i}`, { kind: 'decision', summary: `Open ${i}` } as Partial<Card>)),
      stored('mail:d:z', { kind: 'decision', summary: 'Asleep', snoozed_until: '2026-10-09T08:00:00Z' } as Partial<Card>),
    ];
    const card = fold({ ...input, openDecisions: decisions, yesterday: [] });
    const [paragraph] = card.body.split('\n');
    expect(paragraph).toMatch(/^4 decisions, 1 snoozed: \[Open 0\]/);
    expect(paragraph).not.toContain('Asleep');
    expect(entries(card.body).find((l) => l.includes('mail%3Ad%3Az'))).toContain('(snoozed) — Asleep'); // §8: every open decision
    expect(card.references).toContain('mail:d:z');
    // No snoozed decision: no snoozed count.
    expect(fold({ ...input, openDecisions: decisions.slice(0, 4), yesterday: [] }).body.split('\n')[0]).toMatch(/^4 decisions: /);
    // All of them snoozed: the count, and no list.
    const asleep = dailyLines({ openDecisions: decisions.slice(4), yesterday: [], at: input.emittedAt });
    expect(dailyParagraph(asleep, input.cardUrl)).toBe('0 decisions, 1 snoozed.');
  });

  it('treats a snooze that has run out as no snooze', () => {
    const woke = stored('mail:d:w', { kind: 'decision', summary: 'Awake again', snoozed_until: '2026-10-07T03:00:00Z' } as Partial<Card>);
    expect(fold({ ...input, openDecisions: [woke], yesterday: [] }).body.split('\n')[0]).toBe('1 decision: [Awake again](<https://head.example/card/mail%3Ad%3Aw>).');
  });

  it('mints nothing on a day with nothing open and nothing new; says only what there is otherwise', () => {
    expect(foldDaily({ ...input, openDecisions: [], yesterday: [] })).toBeNull();
    expect(dailyParagraph({ decisions: [], threads: [] }, input.cardUrl)).toBe('');
    const quiet = fold({ ...input, openDecisions: [] });
    expect(quiet.body.split('\n')[0]).toMatch(/^Yesterday: /);
  });
});
