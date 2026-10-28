'use client';

// The front door's demo brief: the brief's own components (the day layout, DecisionCard, UpdateRow, WeekStrip,
// OrderBlock, DailyBrief) on the demo head the server replayed (lib/demo/replay.ts), rendered on the server, so the page
// shows them without JavaScript. With it, they work but keep nothing: a sandbox (app/(ui)/client.ts) answers every
// call, so deciding or acknowledging settles the card for this visitor only and nothing is sent. Links to a card stay
// on the page: they scroll to the card in its frame.

import { Moon, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { setSandbox } from '../(ui)/client';
import { LocaleContext, type MeCard } from '../(ui)/components';
import { DaySection, shortDay, weekOf } from '../(ui)/brief/day-section';
import type { Day } from '../(ui)/brief/days';
import { DecisionCard, type Density } from '../(ui)/brief/DecisionCard';
import { UpdateRow, type UpdateThread } from '../(ui)/brief/UpdateRow';
import { WeekStrip } from '../(ui)/brief/WeekStrip';
import { OrderBlock } from '../(ui)/orders/orders-view';
import type { DemoHead } from '../../lib/demo/replay';

/** The demo's times and dates are written in one locale, whatever the visitor's (the day names come from the server). */
const DEMO_LOCALE = 'en-GB';

/** Answers the brief's calls in place of a head: the change it would have made, kept by the page alone. */
function demoAnswer(path: string, init: { method: string; body?: unknown }) {
  const m = /^\/api\/me\/cards\/[^/]+\/(decision|seen|ack|snooze|unsnooze)$/.exec(path);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (init.method === 'POST' && m) {
    const body = (init.body ?? {}) as Record<string, unknown>;
    switch (m[1]) {
      case 'decision':
        return { status: 200, body: { ...body, state: 'decided', decided_at: at } };
      case 'seen':
        return { status: 200, body: { seen_at: at } };
      case 'ack':
        return { status: 200, body: { acknowledged_at: at } };
      case 'snooze':
        return { status: 200, body: { snoozed_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') } };
      case 'unsnooze':
        return { status: 200, body: { snoozed_until: null } };
    }
  }
  return { status: 403, body: { error: 'demo', message: 'This is a demo: nothing is sent.' } };
}

/** Installs the sandbox for the page's life, and keeps links to a card inside the demo. */
export function DemoSandbox() {
  useEffect(() => {
    setSandbox(demoAnswer);
    const click = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('[data-demo] a[href^="/card/"]');
      if (!a) return;
      e.preventDefault();
      const id = decodeURIComponent(a.getAttribute('href')!.slice('/card/'.length));
      a.closest('[data-demo]')?.querySelector(`[data-card="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    document.addEventListener('click', click);
    return () => {
      setSandbox(null);
      document.removeEventListener('click', click);
    };
  }, []);
  return null;
}

/** The day with one card changed, as the brief does: a snoozed decision leaves the list until it wakes. */
function changed(day: Day, card: MeCard): Day {
  const swap = (c: MeCard) => (c.id === card.id ? card : c);
  const awake = (c: MeCard) => !c.snoozed_until || Date.parse(c.snoozed_until) <= Date.now();
  return { ...day, decisions: day.decisions.map(swap).filter(awake) };
}

/** The masthead as the app draws it, inside the frame: the name, the dateline, the week, density, search, theme. */
function FrameMasthead({ head, dateline, wide, density, onDensity }: { head: DemoHead; dateline: string; wide: boolean; density: Density; onDensity: (d: Density) => void }) {
  const open = new Set(head.today.decisions.map((c) => c.day));
  const week = weekOf(head.date).map((date) => ({ date, open: open.has(date), reachable: date >= head.date && date <= head.tomorrow.date }));
  const strip = <WeekStrip days={week} selected={head.date} today={head.date} min={head.date} max={head.tomorrow.date} onSelect={() => undefined} />;
  const tools = (
    <div className="flex items-center gap-1 text-muted-foreground" aria-hidden>
      {wide && (
        <Tabs value={density} onValueChange={(v) => onDensity(v as Density)}>
          <TabsList className="h-6 p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
            <TabsTrigger value="comfortable" className="px-2 py-0 text-xs">Comfortable</TabsTrigger>
            <TabsTrigger value="ledger" className="px-2 py-0 text-xs">Ledger</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <span className="grid size-8 place-items-center"><Search className="size-4" /></span>
      <span className="grid size-8 place-items-center"><Moon className="size-4" /></span>
    </div>
  );
  const name = (
    <div className="flex-none">
      <p className={cn('font-serif font-semibold tracking-editorial text-foreground', wide ? 'text-masthead' : 'text-masthead-sm')}>Brief</p>
      <p className="mt-0.5 whitespace-nowrap text-lead text-muted-foreground">{dateline}</p>
    </div>
  );
  return wide ? (
    <div className="flex items-center gap-8 border-b px-6 py-3">
      {name}
      <div className="max-w-xl min-w-0 flex-1">{strip}</div>
      <div className="ml-auto">{tools}</div>
    </div>
  ) : (
    <div className="border-b px-4 pt-3 pb-2">
      <div className="flex items-start justify-between">{name}{tools}</div>
      <div className="mt-2">{strip}</div>
    </div>
  );
}

/** The day headers, named on the server so the page reads the same before and after it hydrates, whatever the locale. */
export type DayNames = Record<string, string>;

/** Today and tomorrow, in one layout, with the frame's own state: what this visitor did to the cards. */
function DemoDays({ head, names, wide, density }: { head: DemoHead; names: DayNames; wide: boolean; density: Density }) {
  const [today, setToday] = useState<Day>(head.today as Day);
  const tz = head.timezone;
  const change = (c: MeCard) => setToday((d) => changed(d, c));
  const decision = (c: MeCard, under: string) => (
    <DecisionCard key={c.id} card={c} timezone={tz} density={density} onChange={change} showTime={wide} {...(c.day && c.day > under ? { forDay: shortDay(c.day) } : {})} />
  );
  const update = (t: UpdateThread) => <UpdateRow key={t.latest.id} thread={t} timezone={tz} density={density} />;
  return (
    <div className={cn('pb-6', wide ? 'px-6' : 'px-4')} style={{ ['--masthead-h' as string]: '0px' }}>
      {[today, head.tomorrow as Day].map((d) => (
        <DaySection key={d.date} day={d} name={names[d.date] ?? d.date} wide={wide} density={density} tz={tz} decision={decision} update={update} />
      ))}
    </div>
  );
}

/** A window onto the app: a hairline frame with its masthead, the content scrolling inside it. */
function Frame({ head, dateline, wide, className, bodyClassName, children }: {
  head: DemoHead; dateline: string; wide: boolean; className?: string; bodyClassName?: string; children: (density: Density) => ReactNode;
}) {
  const [density, setDensity] = useState<Density>('comfortable');
  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border bg-background text-left shadow-sm', className)} data-demo>
      <FrameMasthead head={head} dateline={dateline} wide={wide} density={density} onDensity={setDensity} />
      <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', bodyClassName)}>{children(density)}</div>
    </div>
  );
}

/**
 * The hero: the brief as it opens on the demo head. A broadsheet from 900 px, drawn at 960 px and scaled to its column
 * from 1100 px; the timeline below 900 px. Each is a live component tree with its own state.
 */
export function HeroBrief({ head, names, dateline }: { head: DemoHead; names: DayNames; dateline: string }) {
  return (
    // One locale for its times, on the server and in the browser alike, so the page reads the same before and after it hydrates.
    <LocaleContext value={DEMO_LOCALE}>
    <div data-hero-brief>
      <DemoSandbox />
      <div className="hidden min-[900px]:block" data-hero-layout="broadsheet">
        <div className="min-[1100px]:w-[960px] min-[1100px]:[zoom:0.6]">
          <Frame head={head} dateline={dateline} wide className="h-[640px] min-[1100px]:h-[900px]">
            {(density) => <DemoDays head={head} names={names} wide density={density} />}
          </Frame>
        </div>
      </div>
      {/* On a phone the frame runs to the screen's edges, as the app does, so the week strip has the app's room. */}
      <div className="-mx-4 min-[560px]:mx-0 min-[900px]:hidden" data-hero-layout="timeline">
        <Frame head={head} dateline={dateline} wide={false} className="h-[640px] rounded-none border-x-0 min-[560px]:rounded-lg min-[560px]:border-x">
          {(density) => <DemoDays head={head} names={names} wide={false} density={density} />}
        </Frame>
      </div>
    </div>
    </LocaleContext>
  );
}

/** One of "the same card" frames: drawn at `width` and scaled into a fixed 245 × 320 box; a picture you can't click. */
function Still({ width, caption, children }: { width: number; caption: string; children: ReactNode }) {
  const zoom = 245 / width;
  return (
    <figure className="w-[245px] flex-none snap-start" data-still={caption}>
      <div className="h-[320px] w-[245px] overflow-hidden rounded-lg border bg-background" inert>
        <div style={{ width, zoom }}>{children}</div>
      </div>
      <figcaption className="pt-2 text-lead text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

/** "The same card. Any device. Any view.": the timeline, the broadsheet, orders and a card, each the real tree. */
export function SameCard({ head, names, dateline }: { head: DemoHead; names: DayNames; dateline: string }) {
  const tz = head.timezone;
  const active = head.orders.filter((o) => o.exec_state === 'open' || o.exec_state === 'claimed');
  const done = head.orders.filter((o) => !(o.exec_state === 'open' || o.exec_state === 'claimed'));
  const outcome = (o: (typeof head.orders)[number]) =>
    o.progress.latest && <UpdateRow thread={{ latest: o.progress.latest as MeCard, earlier: [] }} timezone={tz} density="comfortable" />;
  const stills = useMemo(
    () => [
      { caption: 'Phone · timeline', width: 375, node: <Frame head={head} dateline={dateline} wide={false} className="h-[490px] rounded-none border-0">{(d) => <DemoDays head={head} names={names} wide={false} density={d} />}</Frame> },
      { caption: 'Desktop · broadsheet', width: 1100, node: <Frame head={head} dateline={dateline} wide className="h-[1437px] rounded-none border-0">{(d) => <DemoDays head={head} names={names} wide density={d} />}</Frame> },
      {
        caption: 'Orders',
        width: 560,
        node: (
          <div className="px-4 py-4">
            <h3 className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">Open <span className="font-normal">({active.length})</span></h3>
            <div className="flex flex-col gap-3">
              {active.map((o) => (
                <div key={o.id}>
                  <OrderBlock order={o as MeCard} timezone={tz} onChanged={() => undefined} />
                  {o.progress.latest && <div className="ml-4 border-l pl-3">{outcome(o)}</div>}
                </div>
              ))}
            </div>
            <h3 className="pt-6 pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">Done <span className="font-normal">({done.length})</span></h3>
            <div className="divide-y border-y">{done.map((o) => <div key={o.id}>{outcome(o)}</div>)}</div>
          </div>
        ),
      },
      { caption: 'Card detail', width: 560, node: <div className="p-4"><DecisionCard card={head.detail as MeCard} timezone={tz} density="comfortable" onChange={() => undefined} expanded /></div> },
    ],
    [head, names, dateline, active, done, tz], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return (
    <LocaleContext value={DEMO_LOCALE}>
      <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 min-[1100px]:mx-0 min-[1100px]:overflow-visible min-[1100px]:px-0" data-same-card>
        {stills.map((s) => (
          <Still key={s.caption} width={s.width} caption={s.caption}>{s.node}</Still>
        ))}
      </div>
    </LocaleContext>
  );
}
