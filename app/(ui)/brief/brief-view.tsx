'use client';

// The brief, in two layouts by viewport, made of the same four components (DecisionCard, UpdateRow, DailyBrief,
// WeekStrip; docs/mobile-prd.md).
//
//   < 900 px   timeline: masthead, week strip, then the days top to bottom, each with a sticky dated header and a thin
//              rail of times; today first on load, earlier days loaded above as the person scrolls up, tomorrow below.
//   ≥ 900 px   broadsheet: the week strip in the masthead; each day in two columns, 60/40, decisions on the left,
//              updates and signals on the right; the same past-above, future-below scrolling; j/k/enter/d.

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { MeCard } from '../components';
import { DailyBrief } from './DailyBrief';
import { clock, DecisionCard, type DecisionCardHandle, type Density } from './DecisionCard';
import { Masthead, useDensity } from './masthead';
import { UpdateRow, type UpdateRowHandle, type UpdateThread } from './UpdateRow';
import { addDays, MAX_DAYS_BACK, useBrief, type Day } from './use-brief';
import { WeekStrip, type WeekDay } from './WeekStrip';

const WIDE = '(min-width: 900px)';
/** Updates are folded after this many, behind "More updates (N)". */
const FOLD_AT = 6;
const HINT_KEY = 'pbcp.swipe-hint';
/** How long the swipe hint stays up, unless the person scrolls first. */
const HINT_MS = 8000;

function useWide(): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const m = matchMedia(WIDE);
    const set = () => setWide(m.matches);
    set();
    m.addEventListener('change', set);
    return () => m.removeEventListener('change', set);
  }, []);
  return wide;
}

const dayName = (d: Day, today: string): string => {
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`));
  if (d.date === today) return `Today · ${date}`;
  if (d.date === addDays(today, -1)) return `Yesterday · ${date}`;
  if (d.date === addDays(today, 1)) return `Tomorrow · ${date}`;
  return date;
};

/** The Monday-first week around `date`. */
const weekOf = (date: string): string[] => {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => addDays(date, i - dow));
};

export function BriefView() {
  const wide = useWide();
  const [density, setDensity] = useDensity();
  const { brief, days, cachedAt, error, loadDay, loadedBack, change } = useBrief();
  const [selected, setSelected] = useState<string | null>(null);
  const [todayOut, setTodayOut] = useState<'above' | 'below' | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<string, DecisionCardHandle | UpdateRowHandle | null>());
  const anchor = useRef<{ el: Element; docTop: number } | null>(null);
  const jumpTo = useRef<string | null>(null);
  const today = brief?.date ?? '';

  // The masthead's height, for the sticky day headers and the "Back to today" chip.
  useEffect(() => {
    const m = document.querySelector<HTMLElement>('[data-masthead]');
    if (!m) return;
    const set = () => document.documentElement.style.setProperty('--masthead-h', `${m.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(m);
    return () => ro.disconnect();
  }, [brief !== null, wide]);

  // Earlier days load above the view. The first day on screen is pinned where it was, so nothing the person is looking
  // at moves (done by hand: Safari has no CSS scroll anchoring). On load that keeps today under the masthead.
  const loadEarlier = useCallback(
    async (date: string) => {
      const mast = document.querySelector('[data-masthead]')?.getBoundingClientRect().bottom ?? 0;
      const el = [...document.querySelectorAll('section[data-section]')].find((s) => s.getBoundingClientRect().bottom > mast);
      // Its place in the document, not on screen: scrolling while the day loads must not be undone.
      anchor.current = el ? { el, docTop: el.getBoundingClientRect().top + scrollY } : null;
      await loadDay(date);
    },
    [loadDay],
  );
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    // What was inserted above it, exactly: compensate that, and nothing the person scrolled meanwhile.
    const inserted = a.el.getBoundingClientRect().top + scrollY - a.docTop;
    if (inserted) scrollBy({ top: inserted, behavior: 'instant' });
  }, [loadedBack]);

  // The sentinel above the first day loads the one before it, back to MAX_DAYS_BACK.
  const first = days[0]?.date;
  useEffect(() => {
    const el = top.current;
    if (!el || !first || !today) return;
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting && first > addDays(today, -MAX_DAYS_BACK)) void loadEarlier(addDays(first, -1));
    }, { rootMargin: '400px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [first, today, loadEarlier]);

  // The day in view (the last header that has reached the masthead) is the selected day; today's header leaving
  // the view shows "Back to today".
  useEffect(() => {
    if (!today) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const mast = document.querySelector('[data-masthead]')?.getBoundingClientRect().bottom ?? 0;
      let current = today;
      for (const h of document.querySelectorAll<HTMLElement>('[data-day]')) if (h.getBoundingClientRect().top <= mast + 8) current = h.dataset.day!;
      setSelected(current);
      const t = document.querySelector<HTMLElement>(`[data-day="${today}"]`)?.closest('section')?.getBoundingClientRect();
      setTodayOut(!t ? null : t.bottom < mast ? 'above' : t.top > innerHeight ? 'below' : null);
    };
    const onScroll = () => void (frame ||= requestAnimationFrame(update));
    update();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    return () => {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [today, days.length]);

  const scrollToDay = useCallback((date: string) => {
    const section = () => document.querySelector<HTMLElement>(`[data-day="${date}"]`)?.closest('section');
    const offset = () => {
      const h = section();
      const mast = document.querySelector('[data-masthead]')?.getBoundingClientRect().height ?? 0;
      return h ? h.getBoundingClientRect().top - mast : 0;
    };
    if (!section()) return false;
    scrollTo({ top: scrollY + offset(), behavior: 'smooth' });
    // A smooth scroll aims at where the day was when it started; a day loading above meanwhile moves it. Once the
    // scroll has settled, put the day exactly under the masthead.
    for (const ms of [450, 900]) setTimeout(() => Math.abs(offset()) > 2 && scrollBy({ top: offset(), behavior: 'instant' }), ms);
    return true;
  }, []);
  // A day tapped on the strip that is not loaded yet: load back to it, then go.
  const select = async (date: string) => {
    if (scrollToDay(date)) return;
    jumpTo.current = date;
    for (let d = addDays(first ?? today, -1); d >= date; d = addDays(d, -1)) await loadDay(d);
  };
  useEffect(() => {
    if (jumpTo.current && scrollToDay(jumpTo.current)) jumpTo.current = null;
  }, [loadedBack, scrollToDay]);

  // The swipe hint: shown once per device, then never again. Once shown it also leaves the screen (after a few
  // seconds, or when the person first scrolls): a home-screen app on iOS is resumed rather than reloaded, so a hint that only
  // went away on the next load stayed up on every launch.
  useEffect(() => {
    let shown = false;
    try {
      if (!localStorage.getItem(HINT_KEY)) {
        localStorage.setItem(HINT_KEY, 'shown');
        shown = true;
      }
    } catch {
      // no storage: no hint
    }
    if (!shown) return;
    setHint(true);
    const hide = () => setHint(false);
    const timer = setTimeout(hide, HINT_MS);
    // The person's own scrolling, not the brief's (it scrolls itself to keep today in place as earlier days load).
    addEventListener('wheel', hide, { once: true, passive: true });
    addEventListener('touchmove', hide, { once: true, passive: true });
    return () => {
      clearTimeout(timer);
      removeEventListener('wheel', hide);
      removeEventListener('touchmove', hide);
    };
  }, []);

  // Broadsheet keys: j/k move between cards, enter opens, d dismisses a decision (after the undo window).
  useEffect(() => {
    if (!wide) return;
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return;
      const ids = [...document.querySelectorAll<HTMLElement>('[data-card]')].map((el) => el.dataset.card!);
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const i = focus ? ids.indexOf(focus) : -1;
        const next = ids[Math.min(Math.max(e.key === 'j' ? i + 1 : i - 1, 0), ids.length - 1)];
        if (!next) return;
        setFocus(next);
        document.querySelector<HTMLElement>(`[data-card="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (focus && e.key === 'Enter' && !target.closest('button, a, summary')) {
        e.preventDefault();
        const h = handles.current.get(focus);
        if (h && 'expand' in h) h.expand();
        else if (h && 'open' in h) h.open();
      } else if (focus && e.key === 'd') {
        const h = handles.current.get(focus);
        if (h && 'dismiss' in h) h.dismiss();
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [wide, focus]);

  if (error) return <main className="mx-auto max-w-xl p-4 text-destructive">{error}</main>;
  if (!brief || wide === null) return <main className="mx-auto max-w-xl p-4 text-muted-foreground">Loading…</main>;

  const tz = brief.timezone;
  const shownDay = selected ?? today;
  const openOn = new Set(brief.decisions.map((c) => c.received_at.slice(0, 10)));
  const reachableFrom = addDays(today, -MAX_DAYS_BACK);
  const week: WeekDay[] = weekOf(shownDay).map((date) => ({ date, open: openOn.has(date), reachable: date >= reachableFrom && date <= addDays(today, 1) }));
  const strip = <WeekStrip days={week} selected={shownDay} today={today} onSelect={(d) => void select(d)} />;
  const allCards: MeCard[] = days.flatMap((d) => [...d.decisions, ...d.updates.map((t) => t.latest), ...d.signals.map((t) => t.latest)]);
  const register = (id: string) => (h: DecisionCardHandle | UpdateRowHandle | null) => void handles.current.set(id, h);

  const decision = (c: MeCard) => (
    <DecisionCard key={c.id} card={c} timezone={tz} density={density} onChange={change} focused={focus === c.id} handle={register(c.id)} showTime={wide} />
  );
  const update = (t: UpdateThread) => (
    <UpdateRow key={t.latest.id} thread={t} timezone={tz} density={density} focused={focus === t.latest.id} handle={register(t.latest.id)} />
  );

  return (
    <div className="min-h-dvh pb-24">
      <Masthead today={today} timezone={tz} density={density} onDensity={setDensity} cards={allCards} cachedAt={cachedAt} strip={strip} wide={wide} />
      <main className={cn('mx-auto max-w-[1440px]', wide ? 'px-6' : 'px-4')}>
        <div ref={top} aria-hidden className="h-px" />
        {first && first <= reachableFrom && <p className="py-4 text-center text-lead text-muted-foreground">The brief goes back {MAX_DAYS_BACK} days.</p>}
        {days
          // An earlier day with nothing on it is not shown: no header for an empty day.
          .filter((d) => d.kind !== 'past' || d.paragraph || d.decisions.length || d.updates.length || d.signals.length)
          .map((d) => (
            <DaySection key={d.date} day={d} name={dayName(d, today)} wide={wide} density={density} tz={tz} decision={decision} update={update} />
          ))}
      </main>
      {todayOut && (
        <div className="fixed inset-x-0 z-30 flex justify-center" style={{ top: 'calc(var(--masthead-h, 120px) + 8px)' }}>
          <Button size="sm" variant="outline" className="bg-background" onClick={() => scrollToDay(today)}>
            {todayOut === 'above' ? <ArrowDown /> : <ArrowUp />} Back to today
          </Button>
        </div>
      )}
      <footer className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 py-2 text-center text-meta text-muted-foreground">
        {wide ? (
          <span><kbd className="font-sans">j</kbd> / <kbd className="font-sans">k</kbd> move · <kbd className="font-sans">enter</kbd> open · <kbd className="font-sans">d</kbd> dismiss</span>
        ) : hint ? (
          <span>Swipe right for the default · swipe left to dismiss</span>
        ) : (
          <span>{brief.snoozed > 0 ? `${brief.snoozed} snoozed` : ' '}</span>
        )}
      </footer>
    </div>
  );
}

function DaySection({ day, name, wide, density, tz, decision, update }: {
  day: Day; name: string; wide: boolean; density: Density; tz: string;
  decision: (c: MeCard) => ReactNode; update: (t: UpdateThread) => ReactNode;
}) {
  const heading = day.kind === 'today' ? 'Today’s brief' : day.kind === 'past' ? 'The brief' : '';
  const empty = day.decisions.length === 0 && day.updates.length === 0 && day.signals.length === 0;
  const brief = heading && <DailyBrief heading={heading} html={day.paragraph?.html ?? null} soFar={day.paragraph?.soFar} compact={density === 'ledger'} />;
  const decisions = day.decisions.length > 0 && (
    <Group title="Decisions" count={day.decisions.length}>
      <Rail wide={wide} tz={tz} items={day.decisions.map((c) => ({ key: c.id, at: c.received_at, node: decision(c) }))} gap={density === 'ledger' ? 'gap-2' : 'gap-3'} />
    </Group>
  );
  const updates = day.updates.length > 0 && <Updates title="Updates" threads={day.updates} wide={wide} update={update} />;
  const signals = day.signals.length > 0 && <Updates title="Signals" threads={day.signals} wide={wide} update={update} />;

  return (
    <section className="pb-6" aria-label={name} data-section>
      <h2
        data-day={day.date}
        className="sticky z-10 -mx-1 border-b bg-background/95 px-1 py-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground"
        style={{ top: 'var(--masthead-h, 0px)' }}
      >
        {name}
      </h2>
      {day.kind === 'tomorrow' && empty ? (
        <p className="py-3 text-lead text-muted-foreground">Nothing set for tomorrow yet.</p>
      ) : wide ? (
        <div className="grid grid-cols-[minmax(0,3fr)_minmax(300px,2fr)] gap-6 pt-3">
          <div className="min-w-0">
            {brief}
            {decisions}
          </div>
          <div className="min-w-0">
            {updates}
            {signals}
          </div>
        </div>
      ) : (
        <div className="pt-1">
          {brief}
          {decisions}
          {updates}
          {signals}
        </div>
      )}
    </section>
  );
}

function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div className="pt-3">
      <h3 className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">
        {title}
        {count !== undefined && <span className="font-normal"> ({count})</span>}
      </h3>
      {children}
    </div>
  );
}

/** On the timeline, each item sits beside a thin rail carrying its time; on the broadsheet, items stand alone. */
function Rail({ wide, items, gap, tz }: { wide: boolean; items: Array<{ key: string; at: string; node: ReactNode }>; gap: string; tz: string }) {
  if (wide) return <div className={cn('flex flex-col', gap)}>{items.map((i) => <div key={i.key}>{i.node}</div>)}</div>;
  return (
    <ol className={cn('flex flex-col', gap)}>
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[2.75rem_minmax(0,1fr)]">
          <span className="border-r pr-2 pt-3 text-right text-meta tabular-nums text-muted-foreground">{clock(i.at, tz)}</span>
          <div className="min-w-0 pl-3">{i.node}</div>
        </li>
      ))}
    </ol>
  );
}

/** Updates or signals: rows separated by hairlines, folded after FOLD_AT behind "More updates (N)". */
function Updates({ title, threads, wide, update }: { title: string; threads: UpdateThread[]; wide: boolean; update: (t: UpdateThread) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? threads : threads.slice(0, FOLD_AT);
  return (
    <Group title={title}>
      <div className={cn('divide-y border-y', !wide && 'ml-[2.75rem] border-l pl-3')}>{shown.map((t) => update(t))}</div>
      {threads.length > FOLD_AT && !all && (
        <button className="mt-2 text-lead text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          More {title.toLowerCase()} ({threads.length - FOLD_AT})
        </button>
      )}
    </Group>
  );
}
