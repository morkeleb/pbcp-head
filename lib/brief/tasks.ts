// Tasks (RFC 0.9 §4.1, §4.5, §8), as the head presents them: when one is due, and whether it is overdue. Pure, for the
// server (the brief, the nightly fold) and the browser (the Tasks section) alike.
//
// Overdue is derived when the task is presented, never a field and never written to the card (§4.5): an open task whose
// `at` has passed or, without `at`, the end of whose `about` day in the head's time zone has passed. A task with
// neither is never overdue.

import { dayRange, instant, localDate } from '../time';

type Due = { at?: string; about?: string };

/** Whether the task's due time (its `at`, else the end of its `about` day) had passed at `asOf`. */
export function pastDue(t: Due, asOf: Date, timezone: string): boolean {
  if (t.at !== undefined) return instant(t.at) < asOf;
  if (t.about !== undefined) return dayRange(t.about, timezone)[1] <= asOf;
  return false;
}

/** §4.5: the task is open and past due now. */
export const isOverdue = (t: Due & { state: string }, now: Date, timezone: string): boolean => t.state === 'open' && pastDue(t, now, timezone);

/**
 * Whether the task was overdue when it was last open: now for an open one; when it was decided, or else closed by its
 * producer (`changed_at`), for one that is not. A task ticked off in the brief stays in the group it was ticked in, so
 * the list does not move under the person's finger.
 */
export function wasOverdue(t: Due & { state: string; decided_at?: string; changed_at?: string }, now: Date, timezone: string): boolean {
  const closed = t.state === 'open' ? undefined : (t.decided_at ?? t.changed_at);
  return pastDue(t, closed ? instant(closed) : now, timezone);
}

/** The day the task is due (§8 a task's day without `received_at`): its `about`, else the day of its `at`; null with neither. */
export function dueDay(t: Due, timezone: string): string | null {
  if (t.about !== undefined) return t.about;
  return t.at !== undefined ? localDate(instant(t.at), timezone) : null;
}

/** Due first, earliest first: `at`, then the end of the `about` day; a task with neither last. Stable for equal times. */
export function byDue(timezone: string) {
  const key = (t: Due) => (t.at !== undefined ? instant(t.at).getTime() : t.about !== undefined ? dayRange(t.about, timezone)[1].getTime() - 1 : Infinity);
  return (a: Due, b: Due) => key(a) - key(b);
}
