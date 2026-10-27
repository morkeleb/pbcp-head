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

  it('opens with the daily paragraph: each decision as its linked title — lead, then one sentence of yesterday’s the same way, nothing else', () => {
    const [paragraph] = fold().body.split('\n');
    expect(paragraph).toMatch(
      /^1 decision, 1 snoozed: \[Reply to Anna re \\\[invoice\\\]\\\(https:\/\/evil\\\.example\\\)\]\(<https:\/\/head\.example\/card\/hermes%3Agmail%3A1>\) — Anna asks whether the invoice can wait until the \*\*20th\*\*\. Yesterday: \[/,
    );
    expect(paragraph).toMatch(/\.$/);
    expect(paragraph).toContain('[Sent](<https://head.example/card/hermes%3Agmail%3Ab>) — The reply went out at 09:12');
    // A lead's own links are unwrapped in the paragraph, whose links are to cards.
    const withLink = fold({ ...input, yesterday: [stored('cal:x:1', { body: 'Moved to [Room 3](https://rooms.example/3) at 10.' })] });
    expect(withLink.body.split('\n')[0]).toContain('Yesterday: [Title cal:x:1](<https://head.example/card/cal%3Ax%3A1>) — Moved to Room 3 at 10.');
  });

  it('names a card with a weak lead by its title, and writes the title alone when the lead is empty or repeats it', () => {
    const weak = stored('mail:inbox:1', { kind: 'decision', title: 'Re: Offsite on the 14th', body: '- **From:** Jonas Holm\n- **Date:** Monday\n\nAre you in for both days?' });
    const same = stored('mail:inbox:2', { kind: 'decision', title: 'Invoice reminder', summary: 'Invoice reminder.' } as Partial<Card>);
    const empty = stored('mail:inbox:3', { kind: 'decision', title: 'Call Lena', body: '' });
    const [paragraph] = fold({ ...input, openDecisions: [weak, same, empty], yesterday: [] }).body.split('\n');
    expect(paragraph).toBe(
      '3 decisions: [Re: Offsite on the 14th](<https://head.example/card/mail%3Ainbox%3A1>) — **From:** Jonas Holm; ' +
        '[Invoice reminder](<https://head.example/card/mail%3Ainbox%3A2>); [Call Lena](<https://head.example/card/mail%3Ainbox%3A3>).',
    );
  });

  it('then lists every open decision that is not snoozed as "title — lead", linked: a summary as text, a body lead as inline markdown', () => {
    const decisionsPart = fold().body.split('**Yesterday**')[0]!;
    const lines = entries(decisionsPart);
    expect(lines[0]).toBe('- [Reply to Anna re \\[invoice\\]\\(https://evil\\.example\\)](<https://head.example/card/hermes%3Agmail%3A1>) — Anna asks whether the invoice can wait until the **20th**.');
    expect(lines).toHaveLength(1); // goalpath:item:9 is snoozed: counted, not listed (§8)
    expect(decisionsPart).not.toContain('GP\\-9');
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

  it('counts a snoozed decision apart and lists it nowhere, neither in the paragraph nor in the entries', () => {
    const decisions = [
      ...Array.from({ length: 4 }, (_, i) => stored(`mail:d:${i}`, { kind: 'decision', summary: `Open ${i}` } as Partial<Card>)),
      stored('mail:d:z', { kind: 'decision', summary: 'Asleep', snoozed_until: '2026-10-09T08:00:00Z' } as Partial<Card>),
    ];
    const card = fold({ ...input, openDecisions: decisions, yesterday: [] });
    const [paragraph] = card.body.split('\n');
    expect(paragraph).toMatch(/^4 decisions, 1 snoozed: \[Title mail:d:0\]\(<[^>]+>\) — Open 0; /);
    expect(paragraph).not.toContain('Asleep');
    expect(card.body).not.toContain('Asleep'); // §8: no snoozed card or its lead until snoozed_until has passed
    expect(card.body).not.toContain('mail%3Ad%3Az');
    expect(card.body).not.toContain('(snoozed)');
    expect(card.body.trimEnd().split('\n').at(-1)).toMatch(/^4 open decisions, 1 snoozed · /);
    // No snoozed decision: no snoozed count.
    expect(fold({ ...input, openDecisions: decisions.slice(0, 4), yesterday: [] }).body.split('\n')[0]).toMatch(/^4 decisions: /);
    // All of them snoozed: the count, and no list.
    const asleep = dailyLines({ openDecisions: decisions.slice(4), yesterday: [], at: input.emittedAt });
    expect(dailyParagraph(asleep, input.cardUrl)).toBe('0 decisions, 1 snoozed.');
  });

  it('shows each of yesterday’s threads by its newest card that is not snoozed, and leaves out a thread snoozed throughout', () => {
    const later = '2026-10-09T08:00:00Z';
    const yesterday = [
      stored('mail:t:1', { thread: 'mail:a', summary: 'First in A' } as Partial<Card>),
      stored('mail:t:2', { thread: 'mail:a', summary: 'Second in A', snoozed_until: later } as Partial<Card>),
      stored('mail:t:3', { thread: 'mail:b', summary: 'Only in B', snoozed_until: later } as Partial<Card>),
      stored('mail:t:4', { thread: 'mail:c', summary: 'Only in C' } as Partial<Card>),
    ];
    const card = fold({ ...input, openDecisions: [], yesterday });
    const [paragraph] = card.body.split('\n');
    expect(paragraph).toBe('Yesterday: [Title mail:t:4](<https://head.example/card/mail%3At%3A4>) — Only in C; [Title mail:t:1](<https://head.example/card/mail%3At%3A1>) — First in A.');
    const listed = entries(card.body.split('**Yesterday**')[1]!);
    expect(listed).toEqual([
      '- [Title mail:t:4](<https://head.example/card/mail%3At%3A4>) — Only in C',
      '- [Title mail:t:1](<https://head.example/card/mail%3At%3A1>) (2 in thread) — First in A',
    ]);
    expect(card.body).not.toMatch(/Second in A|Only in B|mail%3At%3A[23]/);
  });

  it('treats a snooze that has run out as no snooze', () => {
    const woke = stored('mail:d:w', { kind: 'decision', summary: 'Awake again', snoozed_until: '2026-10-07T03:00:00Z' } as Partial<Card>);
    expect(fold({ ...input, openDecisions: [woke], yesterday: [] }).body.split('\n')[0]).toBe('1 decision: [Title mail:d:w](<https://head.example/card/mail%3Ad%3Aw>) — Awake again.');
  });

  it('mints nothing on a day with nothing open and nothing new; says only what there is otherwise', () => {
    expect(foldDaily({ ...input, openDecisions: [], yesterday: [] })).toBeNull();
    expect(dailyParagraph({ decisions: [], threads: [] }, input.cardUrl)).toBe('');
    const quiet = fold({ ...input, openDecisions: [] });
    expect(quiet.body.split('\n')[0]).toMatch(/^Yesterday: /);
  });
});
