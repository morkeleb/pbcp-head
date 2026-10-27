// The masthead's name: on every (ui) route (app/(ui)/chrome.tsx), the sign-in page and the front door (app/about), and
// as the app's name in the manifest and <title>.
export const NAME = 'Brief';

/** The time of day in words, from the hour (0–23) on the device's clock: before 12:00, before 18:00, after. */
export function timeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** The masthead's dateline, "Tue 27 Oct · morning", in the timezone of the clock it is given (the device's). */
export function dateline(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(now);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')} · ${timeOfDay(now.getHours())}`;
}
