// The owner's calendar: dates and wall-clock times in the head's IANA timezone (heads.timezone).

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(instant: Date, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** YYYY-MM-DD of `instant` in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes past local midnight of `instant` in `tz`. */
export function localMinutes(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  return p.hour! * 60 + p.minute!;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The instant at which the wall clock in `tz` reads `date` `time` (HH:MM). DST-correct. */
export function zonedInstant(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz);
    const shown = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return new Date(guess);
}

/** [start, end) of a local day as instants. */
export function dayRange(date: string, tz: string): [Date, Date] {
  return [zonedInstant(date, '00:00', tz), zonedInstant(addDays(date, 1), '00:00', tz)];
}

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
