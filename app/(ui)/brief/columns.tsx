'use client';

// The brief page's two columns, for the app (brief-view.tsx) and the front door's demo (app/about) alike. One layout at
// every width: the brief first in the document and on the left, the day view second and on the right; when they have
// less than 840 px (a phone, or the front door's phone-sized frame on a wide screen) the two stack in that order. The
// width is the columns' own, a container query, not the window's. Nothing above them but the masthead's day navigation.
//
//   Brief                                   [labels]     │  Day view
//   the day's paragraph                                  │  08:00 ┼
//   decision rows, newest first (§4.5)                   │        │ ▌ 09:15–09:30 cal  Design review
//   artifact and signal threads, each to acknowledge     │  10:00 ┼ ● 10:00 hermes  Reply to Anna   (a marker)
//   "2 snoozed, to decide later"                         │  cal · hermes · goalpath   (the legend)

import type { ReactNode } from 'react';
import { composeParagraphs } from '../../../lib/brief/paragraph';
import type { MeCard } from '../components';
import { DailyBrief } from './DailyBrief';
import { anchors, type BriefColumn } from './days';
import { TimeRail } from './TimeRail';
import type { UpdateThread } from './UpdateRow';

export interface BriefColumnsProps {
  /** The brief column for the selected day; null while it loads. */
  column: BriefColumn | null;
  /** The day view's cards (days.ts railCards); null while they load. */
  rail: MeCard[] | null;
  date: string;
  timezone: string;
  /** A tool beside the brief's heading (the label filter). */
  tools?: ReactNode;
  decision: (c: MeCard) => ReactNode;
  thread: (t: UpdateThread) => ReactNode;
}

const heading = 'text-meta font-semibold uppercase tracking-meta text-muted-foreground';

export function BriefColumns({ column, rail, date, timezone, tools, decision, thread }: BriefColumnsProps) {
  const p = column?.paragraph;
  // One short paragraph per part of the brief (lib/brief/paragraph.ts), filtered by the chosen labels; a paragraph the
  // head did not keep in parts is the one run of prose it was written as.
  const paragraphs = !p ? [] : p.parts ? composeParagraphs(p.parts, p.chosen ?? []) : [p.html];
  const empty = column && column.decisions.length === 0 && column.threads.length === 0;
  return (
    <div className="@container">
    <div className="grid gap-x-8 gap-y-6 @min-[840px]:grid-cols-[minmax(0,3fr)_minmax(300px,2fr)]" data-columns>
      <section aria-labelledby="brief-heading" className="min-w-0" data-brief-column>
        <div className="flex min-h-8 items-center justify-between gap-2 border-b pb-1">
          <h2 id="brief-heading" className={heading}>Brief</h2>
          {tools}
        </div>
        {!column ? (
          <p className="py-3 text-lead text-muted-foreground">Loading…</p>
        ) : (
          <>
            {column.today || paragraphs.length > 0 ? (
              <DailyBrief heading={column.today ? 'Today’s brief' : 'Morning brief'} paragraphs={paragraphs} soFar={p?.soFar} />
            ) : null}
            {column.decisions.length > 0 && (
              <div className="flex flex-col gap-3 pt-3" data-brief-decisions>
                {column.decisions.map((c) => decision(c))}
              </div>
            )}
            {column.threads.length > 0 && (
              <div className="mt-3 divide-y border-y" data-brief-threads>
                {column.threads.map((t) => thread(t))}
              </div>
            )}
            {empty && (
              <p className="py-3 text-lead text-muted-foreground" data-brief-empty>
                {column.today ? 'Nothing to decide or acknowledge.' : 'Nothing in this day’s brief.'}
              </p>
            )}
            {column.snoozed > 0 && (
              // §4.2, §8: snoozed open decisions are counted, never listed, nor their leads.
              <p className="pt-3 text-lead text-muted-foreground" data-snoozed={column.snoozed}>
                {column.snoozed} snoozed, to decide later.
              </p>
            )}
          </>
        )}
      </section>
      <section aria-labelledby="day-heading" className="min-w-0" data-day-view>
        <div className="flex min-h-8 items-center border-b pb-1">
          <h2 id="day-heading" className={heading}>Day</h2>
        </div>
        <div className="pt-3">
          {rail === null ? (
            <p className="py-3 text-lead text-muted-foreground">Loading…</p>
          ) : (
            <TimeRail cards={rail} date={date} timezone={timezone} anchors={column ? anchors(column) : new Map()} />
          )}
        </div>
      </section>
    </div>
    </div>
  );
}
