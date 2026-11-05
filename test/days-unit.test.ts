// The brief's days as the page shapes them (app/(ui)/brief/days.ts): which decisions an earlier day lists, and
// how a thread's cards are ordered.

import { describe, expect, it } from 'vitest';
import type { MeCard } from '../app/(ui)/components';
import { aheadOf, pastOf, threads, tomorrowOf, type BriefResponse } from '../app/(ui)/brief/days';

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

describe('threads', () => {
  const artifact = (id: string, received_at: string, change_seq: number, extra: Partial<MeCard> = {}) =>
    ({ id, kind: 'artifact', producer: 'mail', thread: 't', title: id, state: 'open', received_at, change_seq, ...extra }) as MeCard;

  it('takes the thread\'s newest card by arrival: one replaced later (a fresh change_seq) does not become it (§8)', () => {
    const [t] = threads([
      artifact('mail:a', '2026-11-03T09:00:00.000Z', 30, { state: 'superseded' }),
      artifact('mail:b', '2026-11-03T10:00:00.000Z', 12),
    ]);
    expect(t!.latest.id).toBe('mail:b');
    expect(t!.earlier).toEqual([{ id: 'mail:a', title: 'mail:a', received_at: '2026-11-03T09:00:00.000Z', state: 'superseded' }]);
  });
});

describe('a later day’s tasks', () => {
  const task = (id: string, extra: Partial<MeCard>) => ({ id, kind: 'task', producer: 'todo', title: id, state: 'open', change_seq: 1, received_at: '2026-11-01T09:00:00Z', ...extra }) as MeCard;

  it('lists tomorrow a task snoozed until tomorrow, as the head sends it, and not one snoozed past it', () => {
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const b = { timezone: 'UTC', tomorrow: { date: tomorrow, cards: [task('todo:t:snoozed', { snoozed_until: `${tomorrow}T07:00:00Z` }), task('todo:t:later', { snoozed_until: later })] } } as unknown as BriefResponse;
    expect(tomorrowOf(b).tasks.map((c) => c.id)).toEqual(['todo:t:snoozed']);
  });

  it('orders them by when they are due: a time, then the end of a day, then neither', () => {
    const day = aheadOf('2026-11-09', [
      task('todo:t:none', { received_at: '2026-11-01T08:00:00Z' }),
      task('todo:t:day', { about: '2026-11-09', received_at: '2026-11-01T07:00:00Z' }),
      task('todo:t:noon', { at: '2026-11-09T12:00:00Z', received_at: '2026-11-01T10:00:00Z' }),
    ], 'UTC');
    expect(day.tasks.map((c) => c.id)).toEqual(['todo:t:noon', 'todo:t:day', 'todo:t:none']);
  });
});
