// lib/time.ts: a §2 timestamp as an instant, and the day's order of §8.

import { describe, expect, it } from 'vitest';
import { byTime, instant } from '../lib/time';

describe('instant', () => {
  it('reads each UTC offset §2 allows, and a leap second as the end of its minute', () => {
    expect(instant('2026-10-07T09:00:00+00:00').toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(instant('2026-10-07T09:00:00-00:00').toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(instant('2016-12-31T23:59:60Z').toISOString()).toBe('2016-12-31T23:59:59.999Z');
  });
});

describe('byTime (§8)', () => {
  it('puts cards with at first, earliest first, then the rest by received_at', () => {
    const cards = [
      { id: 'plain-late', received_at: '2026-10-07T10:00:00Z' },
      { id: 'at-late', at: '2026-10-07T16:00:00Z', received_at: '2026-10-07T06:00:00Z' },
      { id: 'plain-early', received_at: '2026-10-07T05:00:00Z' },
      { id: 'at-early', at: '2026-10-07T08:00:00.5+00:00', received_at: '2026-10-07T11:00:00Z' },
    ];
    expect(cards.sort(byTime).map((c) => c.id)).toEqual(['at-early', 'at-late', 'plain-early', 'plain-late']);
  });
});
