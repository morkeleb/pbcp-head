import type { Card } from '@pbcp/core';
import { parseCard } from '@pbcp/core';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { dailyLines, dailyParagraph, escapeMarkdown, foldDaily, paragraphParts } from '../lib/brief/fold';
import { composeParagraphs } from '../lib/brief/paragraph';

let seq = 0;
function stored(id: string, extra: Partial<Card> = {}): Card {
  const producer = id.split(':')[0]!;
  return {
    protocol: 'pbcp/1', id, kind: 'artifact', to_person: 'morten', producer, title: `Title ${id}`, body: 'x', urgency: 'brief', delivery: 'brief',
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

  const fold = (i: Parameters<typeof foldDaily>[0] = input) => foldDaily(i);
  const entries = (body: string) => body.split('\n').filter((l) => l.startsWith('- '));

  it('is a valid artifact card under head:daily, brief urgency, referencing the open decisions', () => {
    const card = fold();
    expect(parseCard(card).ok).toBe(true);
    expect(card).toMatchObject({ id: 'head:daily:2026-10-07', kind: 'artifact', urgency: 'brief', producer: 'head', thread: 'daily', title: 'Brief for Wednesday 7 October', references: ['hermes:gmail:1', 'goalpath:item:9'] });
    expect(card).not.toHaveProperty('summary'); // its lead is its opening paragraph
  });

  it('opens with the daily paragraph: each decision as its linked title — lead, then what mattered yesterday the same way, nothing else', () => {
    const [paragraph] = fold().body.split('\n');
    expect(paragraph).toMatch(
      /^1 decision, 1 snoozed: \[Reply to Anna re \\\[invoice\\\]\\\(https:\/\/evil\\\.example\\\)\]\(<https:\/\/head\.example\/card\/hermes%3Agmail%3A1>\) — Anna asks whether the invoice can wait until the \*\*20th\*\*\. What mattered yesterday: \[/,
    );
    expect(paragraph).toMatch(/\.$/);
    expect(paragraph).toContain('[Sent](<https://head.example/card/hermes%3Agmail%3Ab>) — The reply went out at 09:12');
    // A lead's own links are unwrapped in the paragraph, whose links are to cards.
    const withLink = fold({ ...input, yesterday: [stored('cal:x:1', { body: 'Moved to [Room 3](https://rooms.example/3) at 10.' })] });
    expect(withLink.body.split('\n')[0]).toContain('What mattered yesterday: [Title cal:x:1](<https://head.example/card/cal%3Ax%3A1>) — Moved to Room 3 at 10.');
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
    // What a markdown parser finds: one link per entry, each to its card (4 decisions + the 2 threads that mattered yesterday).
    const links: string[] = [];
    const walk = (n: { type: string; url?: string; children?: unknown[] }) => {
      if (n.type === 'link') links.push(n.url!);
      for (const c of (n.children ?? []) as Array<typeof n>) walk(c);
    };
    walk(unified().use(remarkParse).parse(paragraph!) as never);
    expect(links).toHaveLength(6);
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
    expect(dailyParagraph(asleep, input.cardUrl)).toBe('Nothing waiting for you; 1 decision snoozed.');
  });

  it('shows each of yesterday’s threads by its newest card that is not snoozed, and leaves out a thread snoozed throughout', () => {
    const later = '2026-10-09T08:00:00Z';
    const yesterday = [
      stored('mail:t:1', { kind: 'signal', thread: 'mail:a', summary: 'First in A' } as Partial<Card>),
      stored('mail:t:2', { kind: 'signal', thread: 'mail:a', summary: 'Second in A', snoozed_until: later } as Partial<Card>),
      stored('mail:t:3', { kind: 'signal', thread: 'mail:b', summary: 'Only in B', snoozed_until: later } as Partial<Card>),
      stored('mail:t:4', { kind: 'signal', thread: 'mail:c', summary: 'Only in C' } as Partial<Card>),
    ];
    const card = fold({ ...input, openDecisions: [], yesterday });
    const [paragraph] = card.body.split('\n');
    expect(paragraph).toBe('Nothing waiting for you. What mattered yesterday: [Title mail:t:4](<https://head.example/card/mail%3At%3A4>) — Only in C; [Title mail:t:1](<https://head.example/card/mail%3At%3A1>) — First in A.');
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

  it('on a quiet day says "Nothing waiting for you." and nothing of yesterday', () => {
    const quiet = foldDaily({ ...input, openDecisions: [], yesterday: [] });
    expect(quiet.body.split('\n')[0]).toBe('Nothing waiting for you.');
    expect(quiet.body).not.toMatch(/decided|mattered|updates? from/);
    expect(dailyParagraph({ decisions: [], decided: [], mattered: [], rest: [] }, input.cardUrl)).toBe('Nothing waiting for you.');
    // Nothing open, something new: it says only what there is.
    expect(fold({ ...input, openDecisions: [] }).body.split('\n')[0]).toMatch(/^Nothing waiting for you\. What mattered yesterday: /);
  });

  it('weighs the day before by delivery: what was decided, what mattered, and the rest counted, in three paragraphs', () => {
    let at = 0;
    const card = (id: string, extra: Partial<Card>) => stored(id, { received_at: `2026-10-06T${String(8 + Math.floor(at / 60)).padStart(2, '0')}:${String(at++ % 60).padStart(2, '0')}:00Z`, ...extra } as Partial<Card>);
    const decided = [
      card('mail:inbox:anna', { kind: 'decision', title: 'Reply to Anna re invoice timing', state: 'decided', decision: 'agree', decided_at: '2026-10-06T09:10:00Z', actions: [{ id: 'agree', label: 'Agree', default: true }, 'reject'] } as Partial<Card>),
      card('goalpath:item:12', { kind: 'decision', title: 'Accept GP-12?', state: 'decided', decision: 'dismissed', decided_at: '2026-10-06T10:00:00Z' } as Partial<Card>),
    ];
    const yesterday = [
      card('cal:event:7', { kind: 'signal', delivery: 'immediate', urgency: 'immediate', title: 'Moved: Call with Anna now at 16:00', summary: 'It starts at 16:00 (was 16:30)' } as Partial<Card>),
      card('goalpath:alert:db1', { kind: 'signal', delivery: 'immediate', urgency: 'immediate', title: 'db-1 disk at 91%', summary: 'Full in about two days' } as Partial<Card>),
      card('obsidian:daily:6', { kind: 'artifact', title: 'Daily note 2026-10-06', summary: 'Reviewed the billing forecast with Sara' } as Partial<Card>),
      ...['a', 'b', 'c', 'd', 'e'].map((k) => card(`mail:inbox:${k}`, { kind: 'signal', delivery: 'log', urgency: 'log', title: `Newsletter ${k}` } as Partial<Card>)),
      ...['a', 'b', 'c'].map((k) => card(`goalpath:commit:${k}`, { kind: 'signal', delivery: 'log', urgency: 'log', title: `Commit ${k}` } as Partial<Card>)),
      ...['a', 'b'].map((k) => card(`hermes:sync:${k}`, { kind: 'signal', delivery: 'log', urgency: 'log', title: `Synced ${k}` } as Partial<Card>)),
      ...decided,
    ];
    const lines = dailyLines({ openDecisions: [], yesterday, decidedYesterday: decided, at: input.emittedAt });
    const parts = paragraphParts(lines, input.cardUrl);
    const url = (id: string) => `<https://head.example/card/${encodeURIComponent(id)}>`;
    expect(composeParagraphs(parts)).toEqual([
      'Nothing waiting for you.',
      `Yesterday you decided: [Reply to Anna re invoice timing](${url('mail:inbox:anna')}) — decided Agree; [Accept GP\\-12?](${url('goalpath:item:12')}) — decided dismissed.`,
      `What mattered yesterday: [Daily note 2026\\-10\\-06](${url('obsidian:daily:6')}) — Reviewed the billing forecast with Sara; ` +
        `[db\\-1 disk at 91%](${url('goalpath:alert:db1')}) — Full in about two days; [Moved: Call with Anna now at 16:00](${url('cal:event:7')}) — It starts at 16:00 \\(was 16:30\\).`,
      'And 10 updates from mail, goalpath and hermes.',
    ]);
    // The card's lead is the same sentences as one paragraph; the counted ones are only in the body's full list.
    const nightly = foldDaily({ ...input, openDecisions: [], yesterday, decidedYesterday: decided });
    expect(nightly.body.split('\n')[0]).toBe(composeParagraphs(parts).join(' '));
    expect(nightly.body).toContain('**Decided yesterday**');
    expect(nightly.body.split('**Yesterday**')[1]).toContain('Newsletter a');
    expect(composeParagraphs(parts)[3]).not.toContain('Newsletter');
  });

  it('names at most six that mattered, then "and N more"; counts a busy producer’s artifacts with the rest', () => {
    const signals = Array.from({ length: 8 }, (_, i) => stored(`cal:alert:${i}`, { kind: 'signal', title: `Alert ${i}` }));
    const busy = Array.from({ length: 4 }, (_, i) => stored(`n8n:prices:${i}`, { kind: 'artifact', title: `Prices ${i}` }));
    const quiet = stored('obsidian:daily:1', { kind: 'artifact', title: 'Daily note' });
    const [, mattered, rest] = composeParagraphs(paragraphParts(dailyLines({ openDecisions: [], yesterday: [...signals, ...busy, quiet], at: input.emittedAt }), input.cardUrl));
    expect(mattered!.match(/\]\(</g)).toHaveLength(6);
    expect(mattered).toMatch(/; and 3 more\.$/);
    expect(mattered).toContain('Daily note');
    expect(mattered).not.toContain('Prices');
    expect(rest).toBe('And 4 updates from n8n.');
    // Only counted: "Yesterday: …" when nothing is named before it.
    expect(composeParagraphs(paragraphParts(dailyLines({ openDecisions: [], yesterday: busy, at: input.emittedAt }), input.cardUrl))).toEqual(['Nothing waiting for you.', 'Yesterday: 4 updates from n8n.']);
  });

  it('still writes a day folded before fold 6 its own way', () => {
    expect(composeParagraphs({ decisions: [], snoozed: [], yesterday: [{ id: 'x', labels: [], text: 'Old' }] })).toEqual(['Nothing waiting for you.', 'Yesterday: Old.']);
  });
});
