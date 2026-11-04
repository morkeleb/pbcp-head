// The brief's days as the page shapes them (app/(ui)/brief/days.ts): which decisions an earlier day lists.

import { describe, expect, it } from 'vitest';
import type { MeCard } from '../app/(ui)/components';
import { pastOf } from '../app/(ui)/brief/days';

const decision = (id: string, extra: Partial<MeCard>) =>
  ({ id, kind: 'decision', producer: 'cal', title: id, change_seq: 1, received_at: '2026-11-02T09:00:00Z', ...extra }) as MeCard;

describe('pastOf', () => {
  it('lists what was decided that day, a decision later superseded included (§8: its decision stays); not one superseded undecided, nor an open one', () => {
    const day = pastOf('2026-11-02', [
      decision('cal:x:decided', { state: 'decided', decision: 'approve' }),
      decision('cal:x:decided-then-replaced', { state: 'superseded', decision: 'approve' }),
      decision('cal:x:replaced-undecided', { state: 'superseded' }),
      decision('cal:x:open', { state: 'open' }),
    ]);
    expect(day.decisions.map((c) => c.id)).toEqual(['cal:x:decided', 'cal:x:decided-then-replaced']);
  });
});
