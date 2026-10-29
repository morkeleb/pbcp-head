'use client';

// The brief, in two layouts by viewport, made of the same four components (DecisionCard, UpdateRow, DailyBrief,
// WeekStrip; docs/mobile-prd.md).
//
//   < 900 px   timeline: masthead, week strip, then the days top to bottom, each with a sticky dated header and a thin
//              rail of times; today first on load, earlier days loaded above as the person scrolls up (a week at a
//              time, back to the head's first card), tomorrow below; the week strip's month label picks any day.
//   ≥ 900 px   broadsheet: the week strip in the masthead; each day in two columns, 60/40, decisions on the left,
//              updates and signals on the right; the same past-above, future-below scrolling; j/k/enter/d.

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MastheadRow, MastheadTools, useChrome, useChromeCards } from '../chrome';
import type { MeCard } from '../components';
import { matchesLabels } from '../../../lib/brief/paragraph';
import { LabelFilter, useLabelFilter } from './LabelFilter';
import { DecisionCard, type DecisionCardHandle } from './DecisionCard';
import { UpdateRow, type UpdateRowHandle, type UpdateThread } from './UpdateRow';
import { addDays, useBrief, type Day } from './use-brief';
import { dayName, DaySection, shortDay, weekOf } from './day-section';
import { WeekStrip, type WeekDay } from './WeekStrip';

const HINT_KEY = 'pbcp.swipe-hint';
/** How long the swipe hint stays up, unless the person scrolls first. */
const HINT_MS = 8000;

export function BriefView() {
  // The masthead is the layout's (app/(ui)/chrome.tsx): the layout comes from it, the week strip goes into it.
  const { wide } = useChrome();
  const { brief, days, references, cachedAt, error, loadEarlier, loadedFrom, atStart, loadedBack, change } = useBrief();
  const [selected, setSelected] = useState<string | null>(null);
  const [todayOut, setTodayOut] = useState<'above' | 'below' | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<string, DecisionCardHandle | UpdateRowHandle | null>());
  const anchor = useRef<{ el: Element; docTop: number } | null>(null);
  const jumpTo = useRef<string | null>(null);
  const today = brief?.date ?? '';

  // Earlier days load above the view. The first day on screen is pinned where it was, so nothing the person is looking
  // at moves (done by hand: Safari has no CSS scroll anchoring). On load that keeps today under the masthead.
  const loadAbove = useCallback(
    async () => {
      const mast = document.querySelector('[data-masthead]')?.getBoundingClientRect().bottom ?? 0;
      const el = [...document.querySelectorAll('section[data-section]')].find((s) => s.getBoundingClientRect().bottom > mast);
      // Its place in the document, not on screen: scrolling while the day loads must not be undone.
      anchor.current = el ? { el, docTop: el.getBoundingClientRect().top + scrollY } : null;
      await loadEarlier();
    },
    [loadEarlier],
  );
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    // What was inserted above it, exactly: compensate that, and nothing the person scrolled meanwhile.
    const inserted = a.el.getBoundingClientRect().top + scrollY - a.docTop;
    if (inserted) scrollBy({ top: inserted, behavior: 'instant' });
  }, [loadedBack]);

  // The sentinel above the first day loads the week before it, until the head has no earlier cards (§8: every card
  // stays reachable). Observed afresh after each load, so a sentinel still in view loads the next week too.
  useEffect(() => {
    const el = top.current;
    if (!el || !today || atStart) return;
    const io = new IntersectionObserver(([e]) => void (e?.isIntersecting && loadAbove()), { rootMargin: '400px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [today, loadedFrom, atStart, loadAbove]);

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
  // A day tapped on the strip or picked that is not on the timeline yet: load back to it (or show it, when it is loaded
  // but nothing came that day), then go.
  const select = async (date: string) => {
    if (scrollToDay(date)) return;
    jumpTo.current = date;
    await loadEarlier(date);
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

  const allCards: MeCard[] = days.flatMap((d) => [...d.decisions, ...d.updates.map((t) => t.latest), ...d.signals.map((t) => t.latest)]);
  useChromeCards(allCards, { at: cachedAt, timezone: brief?.timezone });
  const [chosen, setChosen] = useLabelFilter();

  if (error) return <main className="mx-auto max-w-xl p-4 text-destructive">{error}</main>;
  if (!brief || wide === null) return <main className="mx-auto max-w-xl p-4 text-muted-foreground">Loading…</main>;

  const tz = brief.timezone;
  const shownDay = selected ?? today;
  const openOn = new Set(brief.decisions.map((c) => c.day ?? c.received_at.slice(0, 10))); // §8: a card's day
  const firstDay = brief.first_day && brief.first_day < today ? brief.first_day : today;
  const lastDay = addDays(today, 1);
  const week: WeekDay[] = weekOf(shownDay).map((date) => ({ date, open: openOn.has(date), reachable: date >= firstDay && date <= lastDay }));
  // The labels on the loaded days, each with how many cards on screen carry it (a card once, wherever it shows).
  const counts = new Map<string, number>();
  for (const c of new Map(allCards.map((c) => [c.id, c])).values()) for (const l of c.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
  const strip = <WeekStrip days={week} selected={shownDay} today={today} min={firstDay} max={lastDay} onSelect={(d) => void select(d)} />;
  // First among the masthead's tools; nothing when no loaded card has a label and none is chosen.
  const labelFilter = (counts.size > 0 || chosen.length > 0) && (
    <MastheadTools>
      <LabelFilter counts={counts} chosen={chosen} onChange={setChosen} compact={!wide} />
    </MastheadTools>
  );
  const shownDays = chosen.length ? days.map((d) => filtered(d, chosen)) : days;
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

  return (
    <div className="min-h-dvh pb-24">
      <MastheadRow>{strip}</MastheadRow>
      {labelFilter}
      <main className={cn('mx-auto max-w-[1440px]', wide ? 'px-6' : 'px-4')}>
        <div ref={top} aria-hidden className="h-px" />
        {shownDays
          // An earlier day with nothing on it is not shown (no header for an empty day), unless the person went to it.
          .filter((d) => d.kind !== 'past' || d.nothing || d.paragraph || d.decisions.length || d.updates.length || d.signals.length)
          .map((d) => (
            <DaySection key={d.date} day={d} name={dayName(d, today)} wide={wide} tz={tz} decision={decision} update={update} />
          ))}
      </main>
      {todayOut && (
        <div className="fixed inset-x-0 z-30 flex justify-center" style={{ top: 'calc(var(--masthead-h, 120px) + 8px)' }}>
          {/* The arrow points the way to scroll: up to a today above the view, down to one below it. */}
          <Button size="sm" variant="outline" className="bg-background" onClick={() => scrollToDay(today)} data-today-is={todayOut}>
            {todayOut === 'above' ? <ArrowUp /> : <ArrowDown />} Back to today
          </Button>
        </div>
      )}
      <footer className="fixed inset-x-0 bottom-0 z-10 border-t bg-background py-2 text-center text-meta text-muted-foreground">
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

