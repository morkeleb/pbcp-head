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
    openDecisions: [stored('hermes:gmail:1', { kind: 'decision', title: 'Reply to Anna re [invoice](https://evil.example)' }), stored('goalpath:item:9', { kind: 'decision', snoozed_until: '2026-10-08T03:30:00Z' })],
    yesterday: [
      stored('hermes:gmail:a', { thread: 'gmail:t1' }),
      stored('hermes:gmail:b', { kind: 'signal', thread: 'gmail:t1', title: 'Sent' }),
      stored('hermes:gmail:1', { kind: 'decision' }),
      stored('goalpath:item:9', { kind: 'decision', decision: 'approve', state: 'decided' }),
    ],
  };

  it('is a valid artifact card under head:daily, brief urgency, referencing the open decisions', () => {
    const card = foldDaily(input);
    expect(parseCard(card).ok).toBe(true);
    expect(card).toMatchObject({ id: 'head:daily:2026-10-07', kind: 'artifact', urgency: 'brief', producer: 'head', thread: 'daily', title: 'Brief for Wednesday 7 October', references: ['hermes:gmail:1', 'goalpath:item:9'] });
  });

  it('counts by producer and kind, lists open decisions, and collapses yesterday by thread', () => {
    const { body } = foldDaily(input);
    expect(body).toContain('**2 open decisions** · 4 cards yesterday from 2 producers');
    expect(body).toContain('```mermaid\npie title Cards yesterday by producer\n  "hermes" : 3\n  "goalpath" : 1\n```');
    expect(body).toContain('| hermes | 1 | 1 | 1 | 3 |');
    expect(body).toContain('| goalpath | 1 | 0 | 0 | 1 |');
    expect(body).toContain('- **goalpath** · Title goalpath:item:9 — since 6 Oct (snoozed)');
    expect(body).toContain('- **hermes** · gmail:t1 — 2 cards, latest “Sent” (signal)');
    expect(body).toContain('(decision, approve)');
  });

  it('escapes producer titles so they cannot add links or images', () => {
    expect(foldDaily(input).body).toContain('Reply to Anna re \\[invoice\\]\\(https://evil\\.example\\)');
    expect(escapeMarkdown('![x](y) <b>')).toBe('\\!\\[x\\]\\(y\\) \\<b\\>');
  });

  it('says so when the day was quiet, without a chart', () => {
    const { body } = foldDaily({ ...input, openDecisions: [], yesterday: [] });
    expect(body).toContain('Nothing is waiting for you.');
    expect(body).toContain('No cards arrived yesterday.');
    expect(body).not.toContain('```mermaid');
  });
});
