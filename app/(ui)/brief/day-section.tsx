'use client';

// A day of the brief, the same component tree in both layouts (brief-view.tsx) and on the front door's demo brief
// (app/about): the sticky dated header, the day's brief in short paragraphs, its decisions, the day's schedule (the
// cards with `at` as an agenda, or on a time rail that shows the free time between them, RFC 0.8 §8), and its updates
// and signals as threads. On the timeline (a phone) they
// follow each other in that order, each decision beside the time it came; on the broadsheet the decisions stand on the
// left, and the schedule above the updates and signals on the right.

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { composeParagraphs } from '../../../lib/brief/paragraph';
import { useLocale, type MeCard } from '../components';
import { DailyBrief } from './DailyBrief';
import { clock } from './DecisionCard';
import { addDays, anchors, type Day, type OrderUpdate } from './days';
import { ScheduleToggle, TimeRail } from './TimeRail';
import type { UpdateThread } from './UpdateRow';

/** Updates are folded after this many, behind "More updates (N)". */
const FOLD_AT = 6;

export const dayName = (d: Day, today: string): string => {
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`));
  if (d.date === today) return `Today · ${date}`;
  if (d.date === addDays(today, -1)) return `Yesterday · ${date}`;
  if (d.date === addDays(today, 1)) return `Tomorrow · ${date}`;
  return date;
};

/** The Monday-first week around `date`. */
export const weekOf = (date: string): string[] => {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => addDays(date, i - dow));
};


export { shortDay } from './days';

export function DaySection({ day, name, wide, tz, decision, update, onChange }: {
  day: Day; name: string; wide: boolean; tz: string;
  /** A card changed on the schedule (acknowledged, snoozed). */
  onChange?: (card: MeCard) => void;
  decision: (c: MeCard, under: string) => ReactNode; update: (t: UpdateThread) => ReactNode;
}) {
  // An earlier day opens with its nightly card (the morning paper for that day); today's is the same fold, so far.
  const heading = day.kind === 'today' ? 'Today’s brief' : day.kind === 'past' ? 'Morning brief' : '';
  const empty = day.decisions.length === 0 && day.updates.length === 0 && day.signals.length === 0 && !day.rail?.length;
  // One short paragraph per part of the brief (lib/brief/paragraph.ts), filtered by the chosen labels; a paragraph the
  // head did not keep in parts is the one run of prose it was written as.
  const p = day.paragraph;
  const paragraphs = !p ? [] : p.parts ? composeParagraphs(p.parts, p.chosen ?? []) : [p.html];
  const brief = heading && <DailyBrief heading={heading} paragraphs={paragraphs} soFar={p?.soFar} />;
  const decisions = day.decisions.length > 0 && (
    <Group title="Decisions" count={day.decisions.length}>
      <Rail wide={wide} tz={tz} items={day.decisions.map((c) => ({ key: c.id, at: c.received_at, node: decision(c, day.date) }))} gap="gap-3" />
    </Group>
  );
  // The day's cards with a time, every producer, `log` included; a card shown above or below is a marker linking to it.
  const schedule = !!day.rail?.length && (
    <Group title="Schedule" tools={<ScheduleToggle />}>
      <div className={cn(!wide && 'ml-[2.75rem] border-l pl-3')} data-schedule>
        <TimeRail cards={day.rail} date={day.date} timezone={tz} anchors={anchors(day)} dayCards={day.cards ?? []} {...(onChange ? { onChange } : {})} />
      </div>
    </Group>
  );
  const updates = (day.updates.length > 0 || !!day.orders?.length) && <Updates title="Updates" threads={day.updates} orders={day.orders ?? []} wide={wide} update={update} tz={tz} />;
  const signals = day.signals.length > 0 && <Updates title="Signals" threads={day.signals} wide={wide} update={update} tz={tz} />;

  return (
    <section className="pb-6" aria-label={name} data-section>
      <h2
        data-day={day.date}
        className="sticky z-10 -mx-1 border-b bg-background px-1 py-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground"
        style={{ top: 'var(--masthead-h, 0px)' }}
      >
        {name}
      </h2>
      {day.kind === 'tomorrow' && empty ? (
        <p className="py-3 text-lead text-muted-foreground">Nothing set for tomorrow yet.</p>
      ) : day.nothing ? (
        <p className="py-3 text-lead text-muted-foreground">{day.kind === 'ahead' ? 'Nothing set for this day yet.' : 'Nothing arrived this day.'}</p>
      ) : wide ? (
        <div className="grid grid-cols-[minmax(0,3fr)_minmax(300px,2fr)] gap-6 pt-3">
          <div className="min-w-0">
            {brief}
            {decisions}
          </div>
          <div className="min-w-0">
            {schedule}
            {updates}
            {signals}
          </div>
        </div>
      ) : (
        <div className="pt-1">
          {brief}
          {decisions}
          {schedule}
          {updates}
          {signals}
        </div>
      )}
    </section>
  );
}

/**
 * An order with news since the last visit (A.3): "<order title> — <the newest progress or outcome's lead>", linking to
 * the orders page, where the order shows its lease and every note. It stands for those cards: they have no rows here.
 */
function OrderUpdateRow({ order, tz }: { order: OrderUpdate; tz: string }) {
  const locale = useLocale();
  const c = order.latest;
  const lead = c.rendered_lead || c.title;
  return (
    <article className="update-row py-3" data-order-update={order.id}>
      <div className="flex items-center gap-2 text-meta font-medium uppercase tracking-meta text-muted-foreground">
        <span>{c.producer}</span>
        <span aria-hidden>·</span>
        <span className="normal-case tracking-normal">order</span>
        <span aria-hidden>·</span>
        <time className="normal-case tracking-normal tabular-nums" dateTime={c.received_at}>{clock(c.received_at, tz, locale)}</time>
        {order.count > 1 && <span className="normal-case tracking-normal">· {order.count} new</span>}
      </div>
      <Link href="/orders" className="block hover:underline">
        <span className="font-serif text-title font-semibold tracking-editorial">{order.title}</span>
        <span className="text-lead text-muted-foreground"> — <span dangerouslySetInnerHTML={{ __html: lead === c.title ? escapeHtml(c.title) : lead }} /></span>
      </Link>
    </article>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' } as Record<string, string>)[ch]};`);

function Group({ title, count, tools, children }: { title: string; count?: number; tools?: ReactNode; children: ReactNode }) {
  return (
    <div className="pt-3">
      <div className="flex items-center justify-between gap-2 pb-2">
        <h3 className="text-meta font-semibold uppercase tracking-meta text-muted-foreground">
          {title}
          {count !== undefined && <span className="font-normal"> ({count})</span>}
        </h3>
        {tools}
      </div>
      {children}
    </div>
  );
}

/** On the timeline, each item sits beside a thin rail carrying its time; on the broadsheet, items stand alone. */
function Rail({ wide, items, gap, tz }: { wide: boolean; items: Array<{ key: string; at: string; node: ReactNode }>; gap: string; tz: string }) {
  const locale = useLocale();
  if (wide) return <div className={cn('flex flex-col', gap)}>{items.map((i) => <div key={i.key}>{i.node}</div>)}</div>;
  return (
    <ol className={cn('flex flex-col', gap)}>
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[2.75rem_minmax(0,1fr)]">
          <span className="border-r pr-2 pt-3 text-right text-meta tabular-nums text-muted-foreground">{clock(i.at, tz, locale)}</span>
          <div className="min-w-0 pl-3">{i.node}</div>
        </li>
      ))}
    </ol>
  );
}

/** Updates or signals: rows separated by hairlines, folded after FOLD_AT behind "More updates (N)". */
function Updates({ title, threads, orders = [], wide, update, tz }: {
  title: string; threads: UpdateThread[]; orders?: OrderUpdate[]; wide: boolean; update: (t: UpdateThread) => ReactNode; tz: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? threads : threads.slice(0, FOLD_AT);
  return (
    <Group title={title}>
      <div className={cn('divide-y border-y', !wide && 'ml-[2.75rem] border-l pl-3')}>
        {orders.map((o) => <OrderUpdateRow key={o.id} order={o} tz={tz} />)}
        {shown.map((t) => update(t))}
      </div>
      {threads.length > FOLD_AT && !all && (
        <button className="mt-2 text-lead text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          More {title.toLowerCase()} ({threads.length - FOLD_AT})
        </button>
      )}
    </Group>
  );
}
