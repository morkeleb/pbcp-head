'use client';

// DatePicker: a month of days, Monday first, in a dialog opened from the week strip's month label. Days from the
// head's first card to tomorrow can be picked; picking one jumps the timeline there. The iOS app mirrors this component.
//
//   ‹  October 2026  ›
//   MON TUE WED THU FRI SAT SUN
//              1   2   3   4
//    5   6   7   8 …

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface DatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The day shown selected, and whose month opens. */
  selected: string;
  today: string;
  /** The first and last days that can be picked, YYYY-MM-DD. */
  min: string;
  max: string;
  onPick: (date: string) => void;
}

const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const pad = (n: number) => String(n).padStart(2, '0');
/** The first of the month `n` months from the month of `date`. */
const monthOf = (date: string, n = 0) => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** The month's days in Monday-first weeks, padded with nulls. */
function grid(first: string): Array<string | null> {
  const d = new Date(`${first}T00:00:00Z`);
  const lead = (d.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let i = 1; i <= days; i++) cells.push(`${first.slice(0, 8)}${pad(i)}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function DatePicker({ open, onOpenChange, selected, today, min, max, onPick }: DatePickerProps) {
  const [month, setMonth] = useState(() => monthOf(selected));
  const [wasOpen, setWasOpen] = useState(open);
  // Each opening starts on the selected day's month.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setMonth(monthOf(selected));
  }
  const prev = monthOf(month, -1);
  const next = monthOf(month, 1);
  const label = fmt(month, { month: 'long', year: 'numeric' });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[22rem] gap-3 p-4" data-date-picker>
        <DialogHeader className="sr-only">
          <DialogTitle>Go to a day</DialogTitle>
          <DialogDescription>Pick a day to show it on the timeline.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between pr-8">
          <Button size="icon-sm" variant="ghost" aria-label="Previous month" disabled={monthOf(min) >= month} onClick={() => setMonth(prev)}>
            <ChevronLeft />
          </Button>
          <span className="font-serif text-day font-semibold tracking-editorial" aria-live="polite">{label}</span>
          <Button size="icon-sm" variant="ghost" aria-label="Next month" disabled={next > max} onClick={() => setMonth(next)}>
            <ChevronRight />
          </Button>
        </div>
        <div role="grid" aria-label={label} className="grid grid-cols-7 gap-1 text-center">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <span key={d} role="columnheader" className="pb-1 text-meta uppercase tracking-meta text-muted-foreground">{d}</span>
          ))}
          {grid(month).map((date, i) =>
            date === null ? (
              <span key={`pad-${i}`} />
            ) : (
              <button
                key={date}
                type="button"
                role="gridcell"
                data-date={date}
                disabled={date < min || date > max}
                aria-current={date === today ? 'date' : undefined}
                aria-selected={date === selected}
                aria-label={fmt(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                onClick={() => {
                  onOpenChange(false);
                  onPick(date);
                }}
                className={cn(
                  'flex min-h-10 items-center justify-center rounded-md text-control tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30',
                  date === selected ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                  date === today && date !== selected && 'font-semibold underline underline-offset-4',
                )}
              >
                {Number(date.slice(8))}
              </button>
            ),
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
