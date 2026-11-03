'use client';

// WeekStrip: the selected day's month, with the previous and next week beside it, then seven days, the selected one
// filled with the accent, a small dot under days with open decisions; tapping a day shows it. The month label opens the
// DatePicker, for any day the brief reaches. The iOS app mirrors this component.
//
//   NOVEMBER 2026 ⌄                                   « »   (a week back, a week on)
//   Mon Tue Wed Thu Fri Sat Sun

import { ChevronDown, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { DatePicker } from './DatePicker';

export interface WeekDay {
  /** YYYY-MM-DD in the head's timezone. */
  date: string;
  /** Has open decisions received that day. */
  open: boolean;
  /** The brief can show it (from the first day it reaches to the last). */
  reachable: boolean;
}

export interface WeekStripProps {
  days: WeekDay[];
  selected: string;
  today: string;
  /** The first and last days the timeline can show, for the picker. */
  min: string;
  max: string;
  onSelect: (date: string) => void;
  className?: string;
}

const plus = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const part = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

export function WeekStrip({ days, selected, today, min, max, onSelect, className }: WeekStripProps) {
  const [picking, setPicking] = useState(false);
  // A week back or on: the same weekday, kept within what the brief reaches.
  const week = (n: number) => {
    const d = plus(selected, 7 * n);
    return d < min ? min : d > max ? max : d;
  };
  const arrow = 'grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  return (
    <div className={className}>
      <div className="flex items-center">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${part(selected, { month: 'long', year: 'numeric' })}: go to a day`}
        onClick={() => setPicking(true)}
        className="-my-1 inline-flex min-h-7 items-center gap-1 rounded-md px-1 text-meta font-semibold uppercase tracking-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        data-month
      >
        {part(selected, { month: 'long', year: 'numeric' })} <ChevronDown className="size-3.5" aria-hidden />
      </button>
        <span className="-my-1 ml-auto flex items-center" data-week-nav>
          <button type="button" aria-label="Previous week" className={arrow} disabled={selected <= min} onClick={() => onSelect(week(-1))} data-week="-1">
            <ChevronsLeft className="size-4" aria-hidden />
          </button>
          <button type="button" aria-label="Next week" className={arrow} disabled={selected >= max} onClick={() => onSelect(week(1))} data-week="1">
            <ChevronsRight className="size-4" aria-hidden />
          </button>
        </span>
      </div>
      <DatePicker open={picking} onOpenChange={setPicking} selected={selected} today={today} min={min} max={max} onPick={onSelect} />
      <nav aria-label="Week" className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const isSelected = d.date === selected;
          return (
            <button
              key={d.date}
              type="button"
              disabled={!d.reachable}
              aria-current={d.date === today ? 'date' : undefined}
              aria-pressed={isSelected}
              aria-label={`${part(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}${d.open ? ', open decisions' : ''}`}
              onClick={() => onSelect(d.date)}
              className={cn(
                'flex min-h-11 flex-col items-center justify-center rounded-md px-1 py-1 text-control outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
                isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
              )}
            >
              <span className={cn('text-meta uppercase tracking-meta', isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{part(d.date, { weekday: 'short' })}</span>
              <span className="font-medium tabular-nums">{part(d.date, { day: 'numeric' })}</span>
              <span className={cn('mt-0.5 size-1 rounded-full', d.open ? (isSelected ? 'bg-primary-foreground' : 'bg-muted-foreground') : 'bg-transparent')} aria-hidden />
            </button>
          );
        })}
      </nav>
    </div>
  );
}
