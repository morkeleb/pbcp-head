import { describe, expect, it } from 'vitest';
import { dateline, NAME, timeOfDay } from '../lib/masthead';

describe('the masthead', () => {
  it('is named Brief', () => expect(NAME).toBe('Brief'));

  it('names the time of day: morning before 12:00, afternoon before 18:00, evening after', () => {
    expect([0, 5, 11].map(timeOfDay)).toEqual(['morning', 'morning', 'morning']);
    expect([12, 15, 17].map(timeOfDay)).toEqual(['afternoon', 'afternoon', 'afternoon']);
    expect([18, 21, 23].map(timeOfDay)).toEqual(['evening', 'evening', 'evening']);
  });

  it('writes the dateline as "Tue 27 Oct · morning" in the clock’s own timezone', () => {
    // The unit project runs in the process's timezone; build the instant from local parts so the hour is local.
    expect(dateline(new Date(2026, 9, 27, 9, 30))).toBe('Tue 27 Oct · morning');
    expect(dateline(new Date(2026, 9, 27, 12, 0))).toBe('Tue 27 Oct · afternoon');
    expect(dateline(new Date(2026, 9, 27, 18, 0))).toBe('Tue 27 Oct · evening');
  });
});
