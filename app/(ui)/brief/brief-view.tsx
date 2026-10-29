'use client';

// The brief page: the masthead's day navigation (WeekStrip, the only control above the columns), then two columns
// (columns.tsx): on the left the paragraph, the open decisions presented as §4.5 requires and the snoozed count; on the
// right the day (§8, a card's time: the day's cards with `at` on a time rail, markers for what the page presents), and
// under it the artifact and signal threads to acknowledge. Together they are the generated brief of §8. One layout at every width; below 900 px the day view
// follows the brief. Keys: j/k move between cards, enter opens, d dismisses a decision (after the undo window).

import { useEffect, useRef, useState } from 'react';
import { MastheadRow, useChrome, useChromeCards } from '../chrome';
import type { MeCard } from '../components';
import { matchesLabels } from '../../../lib/brief/paragraph';
import { BriefColumns } from './columns';
import { addDays, AHEAD, dayName, shortDay, wanting, weekOf, type BriefColumn } from './days';
import { DecisionCard, type DecisionCardHandle } from './DecisionCard';
import { LabelFilter, useLabelFilter } from './LabelFilter';
import { UpdateRow, type UpdateRowHandle, type UpdateThread } from './UpdateRow';
import { useBrief } from './use-brief';
import { WeekStrip, type WeekDay } from './WeekStrip';

const HINT_KEY = 'pbcp.swipe-hint';
/** How long the swipe hint stays up, unless the person scrolls first. */
const HINT_MS = 8000;

export function BriefView() {
  const { wide } = useChrome();
  const { brief, today, date, select, column, rail, references, cachedAt, error, change, acknowledged } = useBrief();
  const [focus, setFocus] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const handles = useRef(new Map<string, DecisionCardHandle | UpdateRowHandle | null>());
  const [chosen, setChosen] = useLabelFilter();

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

  // Keys on a wide screen: j/k move between the brief's rows, enter opens, d dismisses a decision (after the undo window).
  useEffect(() => {
    if (!wide) return;
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return;
      const ids = [...document.querySelectorAll<HTMLElement>('[data-columns] article[data-card]')].map((el) => el.dataset.card!);
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const i = focus ? ids.indexOf(focus) : -1;
        const next = ids[Math.min(Math.max(e.key === 'j' ? i + 1 : i - 1, 0), ids.length - 1)];
        if (!next) return;
        setFocus(next);
        document.querySelector<HTMLElement>(`[data-columns] article[data-card="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

  const onScreen: MeCard[] = column ? [...column.decisions, ...column.threads.map((t) => t.latest)] : [];
  useChromeCards([...onScreen, ...(rail ?? [])], { at: cachedAt, timezone: brief?.timezone });

  if (error) return <main className="mx-auto max-w-xl p-4 text-destructive">{error}</main>;
  if (!brief || !today || !date) return <main className="mx-auto max-w-xl p-4 text-muted-foreground">Loading…</main>;

  const tz = brief.timezone;
  const openOn = new Set(brief.decisions.map((c) => c.day ?? c.received_at.slice(0, 10))); // §8: a card's day
  const firstDay = brief.first_day && brief.first_day < today ? brief.first_day : today;
  const lastDay = addDays(today, AHEAD);
  const week: WeekDay[] = weekOf(date).map((d) => ({ date: d, open: openOn.has(d), reachable: d >= firstDay && d <= lastDay }));
  const asks = column ? wanting(column) : 0;
  const status = (
    <span className="ml-2 min-w-12 text-right text-meta font-semibold text-foreground tabular-nums" data-new-count={asks}>
      {asks > 0 ? `${asks} new` : ''}
    </span>
  );
  const strip = <WeekStrip days={week} selected={date} today={today} min={firstDay} max={lastDay} onSelect={select} status={status} />;

  // The labels on the brief's cards, each with how many carry it; the filter narrows the column (§4.1 SHOULD).
  const counts = new Map<string, number>();
  for (const c of onScreen) for (const l of c.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
  const tools = (counts.size > 0 || chosen.length > 0) && <LabelFilter counts={counts} chosen={chosen} onChange={setChosen} compact={!wide} />;
  const shown = column && chosen.length ? filtered(column, chosen) : column;
  const register = (id: string) => (h: DecisionCardHandle | UpdateRowHandle | null) => void handles.current.set(id, h);

  const decision = (c: MeCard) => (
    <DecisionCard
      key={c.id} card={c} timezone={tz} onChange={change} focused={focus === c.id} handle={register(c.id)}
      paired={(references.get(c.id) ?? []).filter((r) => r.received_at >= c.received_at)}
      // §8: a decision whose day is not the day shown (an open one, under today) says which day it is for.
      {...(c.day && c.day !== date ? { forDay: shortDay(c.day) } : {})}
    />
  );
  const thread = (t: UpdateThread) => (
    <UpdateRow key={t.latest.id} thread={t} timezone={tz} onAcknowledged={acknowledged} focused={focus === t.latest.id} handle={register(t.latest.id)} />
  );

  return (
    <div className="min-h-dvh pb-24">
      <MastheadRow>{strip}</MastheadRow>
      <main className="mx-auto max-w-[1440px] px-4 pt-3 min-[900px]:px-6" aria-label={dayName(date, today)} data-day={date}>
        <BriefColumns column={shown} rail={rail} date={date} timezone={tz} tools={tools} decision={decision} thread={thread} />
      </main>
      {(wide || hint) && (
        <footer className="fixed inset-x-0 bottom-0 z-10 border-t bg-background py-2 text-center text-meta text-muted-foreground">
          {wide ? (
            <span><kbd className="font-sans">j</kbd> / <kbd className="font-sans">k</kbd> move · <kbd className="font-sans">enter</kbd> open · <kbd className="font-sans">d</kbd> dismiss</span>
          ) : (
            <span>Swipe right for the default · swipe left to dismiss</span>
          )}
        </footer>
      )}
    </div>
  );
}

/**
 * The column with the label filter applied: only cards carrying one of `chosen`, decisions and threads (a thread by its
 * newest card); the paragraph keeps only their entries. A paragraph the head did not keep in parts cannot follow the
 * filter, so it is not shown while one is on. The snoozed count is the column's, unfiltered.
 */
function filtered(column: BriefColumn, chosen: string[]): BriefColumn {
  const keep = (c: MeCard) => matchesLabels(c.labels ?? [], chosen);
  const parts = column.paragraph?.parts;
  return {
    ...column,
    decisions: column.decisions.filter(keep),
    threads: column.threads.filter((t) => keep(t.latest)),
    paragraph: column.paragraph && parts ? { ...column.paragraph, parts: { ...parts }, chosen } : null,
  };
}
