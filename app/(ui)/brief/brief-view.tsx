'use client';

// The brief, one day at a time, made of the same components at every width (DecisionCard, UpdateRow, DailyBrief, the
// schedule, WeekStrip; docs/mobile-prd.md).
//
//   masthead   the week strip: the month (the date picker), a week back and on, seven days to tap
//   under it   ‹ Today ›, at the right: the day before, back to today (when elsewhere), the day after
//   the day    its heading ("Today · Tue 3 Nov"), its paragraph, decisions, schedule, updates and signals; on a wide
//              screen the decisions on the left, the rest on the right, with j/k/enter/d
//
// A sideways swipe (or ← and →) goes to the next or the previous day; a day slides in from the side it comes from. The
// day is in the address (/brief?day=2026-11-02), and where the person had scrolled each day is kept for the session, so
// coming back from a card returns to the same day at the same place. What the person is reading stays where it is on
// screen when cards arrive or change (the pin below).

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MastheadRow, MastheadTools, useChrome, useChromeCards } from '../chrome';
import { scrollsSideways, useSwipe, type MeCard } from '../components';
import { matchesLabels } from '../../../lib/brief/paragraph';
import { LabelFilter, useLabelFilter } from './LabelFilter';
import { DecisionCard, type DecisionCardHandle } from './DecisionCard';
import { UpdateRow, type UpdateRowHandle, type UpdateThread } from './UpdateRow';
import { addDays, useBrief, type Day } from './use-brief';
import { dayName, DaySection, shortDay, weekOf } from './day-section';
import { WeekStrip, type WeekDay } from './WeekStrip';
import { AHEAD } from './days';

const HINT_KEY = 'pbcp.swipe-hint';
/** How long the swipe hint stays up, unless the person scrolls first. */
const HINT_MS = 8000;
/** Where the person had scrolled each day, for this session. */
const SCROLL_KEY = (day: string) => `pbcp.brief.scroll.${day}`;
/** A real calendar day as YYYY-MM-DD (not 2026-10-32, which no date arithmetic survives). */
const isDay = (s: string | null): s is string => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export function BriefView() {
  // The masthead is the layout's (app/(ui)/chrome.tsx): the layout comes from it, the week strip goes into it.
  const { wide } = useChrome();
  const { brief, dayOf, loadDay, references, cachedAt, error, change, showing } = useBrief();
  const router = useRouter();
  const asked = useSearchParams().get('day');
  const [focus, setFocus] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  /** Which way the last move went, for the slide: the next day comes in from the right, the day before from the left. */
  const [from, setFrom] = useState<'left' | 'right' | null>(null);
  const handles = useRef(new Map<string, DecisionCardHandle | UpdateRowHandle | null>());
  const today = brief?.date ?? '';

  // The range the brief reaches: any day of the past year (or back to the first card, if earlier), and two weeks ahead.
  const yearAgo = today ? addDays(today, -365) : '';
  const firstDay = brief?.first_day && brief.first_day < yearAgo ? brief.first_day : yearAgo;
  const lastDay = today ? addDays(today, AHEAD) : '';
  const date = today && isDay(asked) && asked >= firstDay && asked <= lastDay ? asked : today;
  showing.current = date || null;
  const day = date ? dayOf(date) : null;
  // An earlier day that could not be loaded says so, with a way to try again, rather than "Loading…" for good.
  const [unloaded, setUnloaded] = useState<string | null>(null);
  useEffect(() => {
    if (!date || day || unloaded === date) return;
    void loadDay(date).then((ok) => void (ok || setUnloaded(date)));
  }, [date, day, loadDay, unloaded]);

  /** Goes to a day: in the address (today is the bare /brief), so Back from a card comes back to it. */
  const go = useCallback(
    (to: string) => {
      if (!today || to === date || to < firstDay || to > lastDay) return;
      setFrom(to > date ? 'right' : 'left');
      setFocus(null);
      router.replace(to === today ? '/brief' : `/brief?day=${to}`, { scroll: false });
    },
    [today, date, firstDay, lastDay, router],
  );

  // What the person is looking at: the first card not under the masthead, where it was on screen, and the scroll
  // position then. Whatever renders (a card decided, a new card arriving, the brief reloaded), that card stays where it
  // was on screen. Done by hand: Safari has no CSS scroll anchoring.
  const pin = useRef<{ el: Element; top: number; y: number } | null>(null);
  const remember = useCallback(() => {
    const mast = document.querySelector('[data-masthead]')?.getBoundingClientRect().bottom ?? 0;
    const below = (sel: string) => [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().bottom > mast + 1);
    const el = below('main [data-card]') ?? below('main section[data-section]');
    pin.current = el ? { el, top: el.getBoundingClientRect().top, y: scrollY } : null;
  }, []);
  const hold = useCallback(() => {
    const p = pin.current;
    // Moved by the page, not by the person: the scroll position is where it was, and the card is not.
    if (p && p.el.isConnected && scrollY === p.y) {
      const moved = p.el.getBoundingClientRect().top - p.top;
      if (Math.abs(moved) > 1) scrollBy({ top: moved, behavior: 'instant' });
    }
    remember();
  }, [remember]);

  // A day shown afresh opens where the person left it this session, or at its top; after that the pin holds the place.
  const placed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!day || placed.current === date) return hold();
    placed.current = date;
    let saved = 0;
    try {
      saved = Number(sessionStorage.getItem(SCROLL_KEY(date)) ?? 0) || 0;
    } catch {
      // no storage: the top
    }
    scrollTo({ top: saved, behavior: 'instant' });
    remember();
    // What the day remembers of itself (a list opened with "More") lays out a moment later: go there again then.
    requestAnimationFrame(() => {
      if (placed.current !== date || Math.abs(scrollY - saved) < 2) return;
      scrollTo({ top: saved, behavior: 'instant' });
      remember();
    });
  });
  const main = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const ro = new ResizeObserver(() => hold());
    ro.observe(el);
    return () => ro.disconnect();
  }, [hold, brief === null]); // eslint-disable-line react-hooks/exhaustive-deps -- the <main> exists once the brief is in

  // The person's own scrolling: the pin follows it, and the day keeps where it was left. Kept once the scrolling has
  // rested, and never as the page leaves: opening a card scrolls to the top of the card's page, which is not this day's
  // place.
  useEffect(() => {
    if (!date) return;
    let frame = 0;
    let rest: ReturnType<typeof setTimeout> | undefined;
    const keep = () => {
      if (placed.current !== date || location.pathname !== '/brief') return;
      try {
        sessionStorage.setItem(SCROLL_KEY(date), String(Math.round(scrollY)));
      } catch {
        // no storage: the day opens at its top
      }
    };
    const update = () => {
      frame = 0;
      hold();
      clearTimeout(rest);
      rest = setTimeout(keep, 200);
    };
    const onScroll = () => void (frame ||= requestAnimationFrame(update));
    addEventListener('scroll', onScroll, { passive: true });
    return () => {
      removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
      clearTimeout(rest);
    };
  }, [date, hold]);

  // A sideways swipe moves between days: left to the next day, right to the day before. It starts anywhere on the page
  // but a field or something that scrolls sideways itself (a wide table).
  const step = useRef<(n: number) => void>(() => undefined);
  step.current = (n: number) => date && go(addDays(date, n));
  const daySwipe = useSwipe((direction) => step.current(direction === 'left' ? 1 : -1));
  // One ref for <main>, stable across renders: a new one each render would detach the swipe's listeners mid-gesture.
  const swipeRef = daySwipe.ref;
  const mainRef = useCallback((el: HTMLElement | null) => {
    main.current = el;
    swipeRef(el);
  }, [swipeRef]);

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
    addEventListener('wheel', hide, { once: true, passive: true });
    addEventListener('touchmove', hide, { once: true, passive: true });
    return () => {
      clearTimeout(timer);
      removeEventListener('wheel', hide);
      removeEventListener('touchmove', hide);
    };
  }, []);

  // Keys: ← and → move between days at every width; on a wide screen j/k move between cards, enter opens, d dismisses a
  // decision (after the undo window).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // A control that moves with the arrows, or something that scrolls sideways (a wide table), keeps them.
        if (e.defaultPrevented || scrollsSideways(target)) return;
        e.preventDefault();
        return step.current(e.key === 'ArrowRight' ? 1 : -1);
      }
      if (!wide) return;
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

  const onScreen: MeCard[] = day ? [...day.decisions, ...day.updates.map((t) => t.latest), ...day.signals.map((t) => t.latest)] : [];
  useChromeCards(onScreen, { at: cachedAt, timezone: brief?.timezone });
  const [chosen, setChosen] = useLabelFilter();

  if (error) return <main className="mx-auto max-w-xl p-4 text-destructive">{error}</main>;
  if (!brief || wide === null) return <main className="mx-auto max-w-xl p-4 text-muted-foreground">Loading…</main>;

  const tz = brief.timezone;
  const openOn = new Set(brief.decisions.map((c) => c.day ?? c.received_at.slice(0, 10))); // §8: a card's day
  const week: WeekDay[] = weekOf(date).map((d) => ({ date: d, open: openOn.has(d), reachable: d >= firstDay && d <= lastDay }));
  // The labels on the day's cards, each with how many carry it.
  const counts = new Map<string, number>();
  for (const c of new Map(onScreen.map((c) => [c.id, c])).values()) for (const l of c.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
  const strip = <WeekStrip days={week} selected={date} today={today} min={firstDay} max={lastDay} onSelect={go} />;
  // First among the masthead's tools; nothing when no card of the day has a label and none is chosen.
  const labelFilter = (counts.size > 0 || chosen.length > 0) && (
    <MastheadTools>
      <LabelFilter counts={counts} chosen={chosen} onChange={setChosen} compact={!wide} />
    </MastheadTools>
  );
  const shown = day && chosen.length ? filtered(day, chosen) : day;
  const register = (id: string) => (h: DecisionCardHandle | UpdateRowHandle | null) => void handles.current.set(id, h);

  // §8: a decision whose day is later than the day it is listed under (an open one, under today) says which day it is for.
  const decision = (c: MeCard, under: string) => (
    <DecisionCard
      key={c.id} card={c} timezone={tz} onChange={change} focused={focus === c.id} handle={register(c.id)} showTime={wide}
      paired={(references.get(c.id) ?? []).filter((r) => r.received_at >= c.received_at)}
      {...(c.day && c.day > under ? { forDay: shortDay(c.day) } : {})}
    />
  );
  const update = (t: UpdateThread) => (
    <UpdateRow key={t.latest.id} thread={t} timezone={tz} focused={focus === t.latest.id} handle={register(t.latest.id)} />
  );
  const nav = 'h-7 px-2 text-muted-foreground';

  return (
    <div className="min-h-dvh pb-24">
      <MastheadRow>{strip}</MastheadRow>
      {labelFilter}
      <main className={cn('mx-auto max-w-[1440px] touch-pan-y overflow-x-clip', wide ? 'px-6' : 'px-4')} ref={mainRef} data-brief-day={date}>
        {/* The day before, back to today, the day after: small, at the right of the day's header line, over it, and held
            under the masthead with the header as the page scrolls (it takes no room: the header slides under it). Today is
            always there, and does nothing on today. */}
        <div
          className="pointer-events-none sticky z-20 -mb-9 flex h-9 items-center justify-end gap-1 [&>*]:pointer-events-auto"
          style={{ top: 'var(--masthead-h, 0px)' }}
          role="group" aria-label="Day" data-day-nav
        >
          <Button size="sm" variant="ghost" className={nav} aria-label="Previous day" disabled={date <= firstDay} onClick={() => go(addDays(date, -1))} data-step="-1">
            <ChevronLeft />
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2.5" disabled={date === today} aria-current={date === today ? 'date' : undefined} onClick={() => go(today)} data-today>
            Today
          </Button>
          <Button size="sm" variant="ghost" className={nav} aria-label="Next day" disabled={date >= lastDay} onClick={() => go(addDays(date, 1))} data-step="1">
            <ChevronRight />
          </Button>
        </div>
        <div
          key={date}
          className={cn('motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200', from === 'right' && 'motion-safe:slide-in-from-right-8', from === 'left' && 'motion-safe:slide-in-from-left-8')}
        >
          {shown ? (
            <DaySection day={shown} name={dayName(shown, today)} wide={wide} tz={tz} decision={decision} update={update} onChange={change} />
          ) : unloaded === date ? (
            <p className="py-6 text-lead text-muted-foreground" role="alert" data-day-unloaded>
              This day could not be loaded.{' '}
              <Button size="sm" variant="outline" className="h-7 px-2.5" onClick={() => setUnloaded(null)}>Try again</Button>
            </p>
          ) : (
            <p className="py-6 text-lead text-muted-foreground">Loading…</p>
          )}
        </div>
      </main>
      <footer className="fixed inset-x-0 bottom-0 z-10 border-t bg-background py-2 text-center text-meta text-muted-foreground">
        {wide ? (
          <span><kbd className="font-sans">←</kbd> / <kbd className="font-sans">→</kbd> day · <kbd className="font-sans">j</kbd> / <kbd className="font-sans">k</kbd> move · <kbd className="font-sans">enter</kbd> open · <kbd className="font-sans">d</kbd> dismiss</span>
        ) : hint ? (
          <span>Swipe left for the next day · right for the day before</span>
        ) : (
          <span>{brief.snoozed > 0 ? `${brief.snoozed} snoozed` : '\u00a0'}</span>
        )}
      </footer>
    </div>
  );
}

/**
 * A day with the label filter applied: only cards carrying one of `chosen`, in decisions, updates and signals (a thread
 * by its newest card); the paragraph keeps only their entries. A paragraph the head did not keep in parts cannot follow
 * the filter, so it is not shown while one is on.
 */
function filtered(day: Day, chosen: string[]): Day {
  const keep = (c: MeCard) => matchesLabels(c.labels ?? [], chosen);
  const parts = day.paragraph?.parts;
  return {
    ...day,
    decisions: day.decisions.filter(keep),
    updates: day.updates.filter((t) => keep(t.latest)),
    signals: day.signals.filter((t) => keep(t.latest)),
    paragraph: day.paragraph && parts ? { ...day.paragraph, parts: { ...parts }, chosen } : null,
  };
}

