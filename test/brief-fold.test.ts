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
      stored('goalpath:item:9', { kind: 'decision', decision: 'approve', state: 'decided', body: 'word '.repeat(80) }),
    ],
  };

  it('is a valid artifact card under head:daily, brief urgency, referencing the open decisions', () => {
    const card = foldDaily(input);
    expect(parseCard(card).ok).toBe(true);
    expect(card).toMatchObject({ id: 'head:daily:2026-10-07', kind: 'artifact', urgency: 'brief', producer: 'head', thread: 'daily', title: 'Brief for Wednesday 7 October', references: ['hermes:gmail:1', 'goalpath:item:9'] });
  });

  it('leads with the open decisions, one line each: producer, linked title, lead', () => {
    const { body } = foldDaily(input);
    const lines = body.split('\n');
    expect(lines[0]).toBe('- **hermes** · [Reply to Anna re \\[invoice\\]\\(https://evil\\.example\\)](<https://head.example/card/hermes%3Agmail%3A1>) — Anna asks whether the invoice can wait until the 20th\\.');
    // The summary is the lead when there is one: plain text, escaped, not cut.
    expect(lines[1]).toBe('- **goalpath** · [Title goalpath:item:9](<https://head.example/card/goalpath%3Aitem%3A9>) (snoozed) — GP\\-9 is finished; accept it?');
  });

  it('then yesterday’s threads by their newest card’s lead, cut at about 200 characters without a summary', () => {
    const { body } = foldDaily(input);
    expect(body).toContain('**Yesterday**');
    expect(body).toContain('- **hermes** · [Sent](<https://head.example/card/hermes%3Agmail%3Ab>) (2 in thread) — The reply went out at 09:12\\.');
    const long = body.split('\n').find((l) => l.includes('goalpath%3Aitem%3A9>) —') && l.includes('word'))!;
    expect(long).toMatch(/word…$/);
    expect(long.split(' — ')[1]!.length).toBeLessThanOrEqual(200);
  });

  it('ends with the counts on one line, and draws no chart', () => {
    const { body } = foldDaily(input);
    expect(body.trimEnd().split('\n').at(-1)).toBe('2 open decisions · 4 cards yesterday from 2 producers');
    expect(foldDaily(input)).toMatchObject({ summary: '2 open decisions · 4 cards yesterday from 2 producers' }); // its lead
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
