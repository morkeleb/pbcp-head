import type { Card } from '@pbcp/core';
import { parseCard } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, foldDaily } from '../lib/brief/fold';

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

  it('is a valid artifact card under head:daily, brief urgency, referencing the open decisions', () => {
    const card = foldDaily(input);
    expect(parseCard(card).ok).toBe(true);
    expect(card).toMatchObject({ id: 'head:daily:2026-10-07', kind: 'artifact', urgency: 'brief', producer: 'head', thread: 'daily', title: 'Brief for Wednesday 7 October', references: ['hermes:gmail:1', 'goalpath:item:9'] });
  });

  it('lists every open decision as "title — lead", linked: a summary as text, a body lead as inline markdown', () => {
    const { body } = foldDaily(input);
    const lines = body.split('\n');
    // The body lead is core's leadOf (§3.1): the first paragraph after the heading, its markdown kept.
    expect(lines[0]).toBe('- [Reply to Anna re \\[invoice\\]\\(https://evil\\.example\\)](<https://head.example/card/hermes%3Agmail%3A1>) — Anna asks whether the invoice can wait until the **20th**.');
    // The summary is the lead when there is one: plain text, so escaped.
    expect(lines[1]).toBe('- [Title goalpath:item:9](<https://head.example/card/goalpath%3Aitem%3A9>) (snoozed) — GP\\-9 is finished; accept it?');
    const many = Array.from({ length: 70 }, (_, i) => stored(`hermes:gmail:m${i}`, { kind: 'decision' }));
    expect(foldDaily({ ...input, openDecisions: many }).body.split('\n').filter((l) => l.startsWith('- [Title hermes:gmail:m'))).toHaveLength(70); // every one
  });

  it('then the previous day’s threads by their newest card’s lead', () => {
    const { body } = foldDaily(input);
    expect(body).toContain('**Yesterday**');
    expect(body).toContain('- [Sent](<https://head.example/card/hermes%3Agmail%3Ab>) (2 in thread) — The reply went out at 09:12.');
    // A body whose first line is a list item: core's lead is that line, kept inline rather than becoming a list.
    expect(body).toContain('— \\- **From:** Jonas');
    // A summary over 280 characters is cut, at a word, with an ellipsis.
    const cut = body.split('\n').find((l) => l.includes('mail%3Ainbox%3A7'))!.split(' — ')[1]!;
    expect(cut.length).toBeLessThanOrEqual(280 + 10);
    expect(cut).toMatch(/…$/);
  });

  it('ends with the counts on one line, and draws no chart', () => {
    const { body } = foldDaily(input);
    expect(body.trimEnd().split('\n').at(-1)).toBe('2 open decisions · 5 cards yesterday from 3 producers');
    expect(foldDaily(input)).toMatchObject({ summary: '2 open decisions · 5 cards yesterday from 3 producers' }); // its lead
    expect(body).not.toContain('```mermaid');
    expect(body).not.toContain('| --- |');
  });

  it('escapes producer titles so they cannot add links or images', () => {
    expect(escapeMarkdown('![x](y) <b>')).toBe('\\!\\[x\\]\\(y\\) \\<b\\>');
  });

  it('says so when the day was quiet', () => {
    const { body } = foldDaily({ ...input, openDecisions: [], yesterday: [] });
    expect(body.split('\n')[0]).toBe('Nothing is waiting for you.');
    expect(body).toContain('No cards arrived yesterday.');
    expect(body).toContain('0 open decisions · 0 cards yesterday from 0 producers');
  });
});
