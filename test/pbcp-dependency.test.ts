import { parseCard } from '@pbcp/core';
import { HeadClient } from '@pbcp/client';
import { describe, expect, it } from 'vitest';

// Guards the pinned protocol dependency (vendor/pbcp, pinned in CLAUDE.md): if the import breaks, nothing else here can work.
describe('@pbcp/core and @pbcp/client', () => {
  it('parses a card', () => {
    const r = parseCard({
      protocol: 'pbcp/1',
      id: 'hermes:gmail:19a4f2e7c3b1',
      kind: 'decision',
      to_person: 'morten',
      producer: 'hermes',
      title: 'Reply to Anna re invoice timing',
      body: 'Anna asks whether the September invoice can be paid on the 20th.',
      emitted_at: '2026-10-07T13:02:11Z',
    });
    expect(r.ok).toBe(true);
  });

  it('exports HeadClient', () => {
    expect(typeof HeadClient).toBe('function');
  });
});
