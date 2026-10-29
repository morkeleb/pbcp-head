'use client';

// WeekStrip: the selected day's month, then seven days, the selected one filled with the accent, a small dot under days
// with open decisions; tapping a day jumps the timeline to it. The month label opens the DatePicker, for any day from
// the head's first card on. The iOS app mirrors this component.

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { DatePicker } from './DatePicker';

export interface WeekDay {
  /** YYYY-MM-DD in the head's timezone. */
  date: string;
  /** Has open decisions received that day. */
  open: boolean;
  /** The timeline can show it (today and earlier, and tomorrow). */
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

const part = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

export function WeekStrip({ days, selected, today, min, max, onSelect, className }: WeekStripProps) {
  const [picking, setPicking] = useState(false);
  return (
    <div className={className}>
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
