'use client';

// TimeRail: a day's schedule (RFC 0.8 §8, a card's time). Every card of the day that carries `at`, from every
// producer, `log` included, in the head's timezone, in one of two modes the person switches between (ScheduleToggle,
// remembered on this device, the same for every day):
//
// - agenda (the default): the cards one under another in time order, each with its time, and nothing between them;
// - timeline: one time axis, each card at its `at`, a bar down to its `until` when it has one, a point when it does
//   not, so the free time between them shows. A bar's length says `until` and nothing else.
//
// In both, colour says which producer sent a card and nothing else; under the cards, the legend: each producer's colour.
//
// A card the brief column presents is a marker here: its time, producer and title, linking to its row in the brief,
// where its body and controls are (§4.5, §8: the ask once, the time beside it). Any other card links to its own page.
// Cards without `at` are not on the rail.
//
//   08:00 ┼
//         │ ● 08:30 cal
//   09:00 ┼   Standup moved                     (a point)
//         │ ▌ 09:15–09:30 cal
//         │ ▌ Design review                     (a bar, as long as the meeting)
//   10:00 ┼

import Link from 'next/link';
import { useSyncExternalStore, type MouseEvent } from 'react';
import { instant, zonedInstant } from '../../../lib/time';
import { cardHref } from '../client';
import { useLocale, type MeCard } from '../components';
import { cardTime } from './card-parts';

/** The producers' colours, in the order they are handed out: distinct from each other in light and dark alike. */
const PALETTE = ['#2f6fdf', '#d9822b', '#2a9d6f', '#c2417a', '#7a5ad8', '#1f9bb5', '#8a9a2b', '#d14b3c'];
const PX_PER_HOUR = 48;
/** The height a label takes, so entries close in time do not overlap: they move into lanes side by side. */
const LABEL_PX = 38;
/** The rail always shows at least this span of the day, wider when a card falls outside it. */
const DAY_START_H = 8;
const DAY_END_H = 18;

export type ScheduleMode = 'agenda' | 'timeline';
const MODE_KEY = 'pbcp.schedule';
const MODE_EVENT = 'pbcp:schedule';

function savedMode(): ScheduleMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'timeline' ? 'timeline' : 'agenda';
  } catch {
    return 'agenda';
  }
}

/** The schedule's mode on this device, followed live: every day's schedule shows the same one. */
export function useScheduleMode(): [ScheduleMode, (m: ScheduleMode) => void] {
  const mode = useSyncExternalStore(
    (changed) => {
      window.addEventListener(MODE_EVENT, changed);
      window.addEventListener('storage', changed);
      return () => {
        window.removeEventListener(MODE_EVENT, changed);
        window.removeEventListener('storage', changed);
      };
    },
    savedMode,
    (): ScheduleMode => 'agenda',
  );
  const set = (m: ScheduleMode) => {
    try {
      if (m === 'agenda') localStorage.removeItem(MODE_KEY);
      else localStorage.setItem(MODE_KEY, m);
    } catch {
      // the choice lasts as long as the page
    }
    window.dispatchEvent(new Event(MODE_EVENT));
  };
  return [mode, set];
}

/** Agenda or timeline: two small buttons, the chosen one pressed. */
export function ScheduleToggle() {
  const [mode, setMode] = useScheduleMode();
  const button = (m: ScheduleMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      data-schedule-mode={m}
      className={`rounded px-2 py-0.5 text-meta font-medium normal-case tracking-normal outline-none focus-visible:ring-2 focus-visible:ring-ring ${mode === m ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {label}
    </button>
  );
  return (
    <span className="flex items-center gap-0.5 rounded-md border p-0.5" role="group" aria-label="Schedule view">
      {button('agenda', 'Agenda')}
      {button('timeline', 'Timeline')}
    </span>
  );
}

/** A colour per producer of the day, by name, so the legend and the rail agree. */
export function producerColours(cards: MeCard[]): Map<string, string> {
  const producers = [...new Set(cards.map((c) => c.producer))].sort();
  return new Map(producers.map((p, i) => [p, PALETTE[i % PALETTE.length]!]));
}

interface Placed {
  card: MeCard;
  /** Minutes from the top of the rail. */
  top: number;
  /** Pixel length of the bar; 0 for a point. */
  bar: number;
  lane: number;
  lanes: number;
}

/** Each card's place on the axis, and its lane among the cards whose labels would overlap it. */
function place(cards: MeCard[], date: string, timezone: string): { placed: Placed[]; fromH: number; toH: number } {
  const dayStart = zonedInstant(date, '00:00', timezone).getTime();
  const minutes = (ts: string) => Math.min(Math.max((instant(ts).getTime() - dayStart) / 60_000, 0), 24 * 60);
  const spans = cards.map((card) => {
    const start = minutes(card.at!);
    return { card, start, end: card.until ? Math.max(minutes(card.until), start) : null };
  });
  const fromH = Math.min(DAY_START_H, ...spans.map((s) => Math.floor(s.start / 60)));
  const toH = Math.max(DAY_END_H, ...spans.map((s) => Math.min(24, Math.ceil(((s.end ?? s.start) + 1) / 60))));
  const k = PX_PER_HOUR / 60;
  const placed: Placed[] = spans.map((s) => ({ card: s.card, top: (s.start - fromH * 60) * k, bar: s.end === null ? 0 : (s.end - s.start) * k, lane: 0, lanes: 1 }));
  // Lanes: greedy, in time order, over each run of entries whose boxes (bar or label, the longer) overlap.
  const bottom = (p: Placed) => p.top + Math.max(p.bar, LABEL_PX);
  let run: Placed[] = [];
  let runEnd = -Infinity;
  const close = () => {
    const lanes = Math.max(1, ...run.map((p) => p.lane + 1));
    for (const p of run) p.lanes = lanes;
    run = [];
  };
  for (const p of placed) {
    if (p.top >= runEnd) close();
    const ends = new Map<number, number>();
    for (const q of run) ends.set(q.lane, Math.max(ends.get(q.lane) ?? -Infinity, bottom(q)));
    let lane = 0;
    while ((ends.get(lane) ?? -Infinity) > p.top) lane++;
    p.lane = lane;
    run.push(p);
    runEnd = Math.max(runEnd, bottom(p));
  }
  close();
  return { placed, fromH, toH };
}

export function TimeRail({ cards, date, timezone, anchors }: {
  cards: MeCard[];
  date: string;
  timezone: string;
  /** Cards the brief column presents, and the id of the row that presents each. */
  anchors: Map<string, string>;
}) {
  const locale = useLocale();
  const [mode] = useScheduleMode();
  const colours = producerColours(cards);
  if (cards.length === 0) return <p className="py-3 text-lead text-muted-foreground" data-rail-empty>Nothing on this day has a time.</p>;

  // A marker scrolls to its card's row in the brief and focuses it; without script, the link alone does.
  const go = (e: MouseEvent<HTMLAnchorElement>, row: string) => {
    const el = document.getElementById(row);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
    history.replaceState(null, '', `#${row}`);
  };

  /** A card's time, producer and title, linking to its row on the brief (a marker) or to its own page. */
  const entry = (card: MeCard) => {
    const row = anchors.get(card.id);
    const time = cardTime(card, timezone, locale);
    const label = (
      <>
        <span className="flex items-baseline gap-1.5 text-meta text-muted-foreground">
          <time className="tabular-nums" dateTime={time.dateTime}>{time.text}</time>
          <span className="truncate uppercase tracking-meta">{card.producer}</span>
        </span>
        <span className="block truncate text-lead text-foreground">{card.title}</span>
      </>
    );
    return row ? (
      // Presented on the brief: a marker, no body and no controls (§4.5).
      <a href={`#${row}`} onClick={(e) => go(e, row)} className="block min-w-0 pl-3 pr-1 hover:underline" data-marker={card.id}>{label}</a>
    ) : (
      <Link href={cardHref(card.id)} className="block min-w-0 pl-3 pr-1 hover:underline">{label}</Link>
    );
  };
  const legend = (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-meta text-muted-foreground" aria-label="Producers" data-legend>
      {[...colours].map(([producer, colour]) => (
        <li key={producer} className="flex items-center gap-1.5" data-legend-producer={producer}>
          <span className="size-2.5 rounded-full" style={{ background: colour }} aria-hidden />
          <span className="uppercase tracking-meta">{producer}</span>
        </li>
      ))}
    </ul>
  );

  if (mode === 'agenda') {
    // In time order, one under another: no free time between them.
    return (
      <div>
        <ol className="flex flex-col gap-2" aria-label="Cards with a time" data-agenda>
          {cards.map((card) => (
            <li key={card.id} className="relative" data-rail-entry={card.id}>
              <span className="absolute left-0 top-[3px] size-2.5 rounded-full" style={{ background: colours.get(card.producer) }} aria-hidden />
              <div className="pl-1">{entry(card)}</div>
            </li>
          ))}
        </ol>
        {legend}
      </div>
    );
  }

  const { placed, fromH, toH } = place(cards, date, timezone);
  const hours = Array.from({ length: toH - fromH + 1 }, (_, i) => fromH + i);
  return (
    <div>
      <div className="relative" style={{ height: (toH - fromH) * PX_PER_HOUR + LABEL_PX }} data-rail>
        {hours.map((h) => (
          <div key={h} className="absolute inset-x-0 flex items-center gap-2" style={{ top: (h - fromH) * PX_PER_HOUR - 7 }} aria-hidden>
            <span className="w-10 flex-none text-right text-meta tabular-nums text-muted-foreground">{String(h).padStart(2, '0')}:00</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        ))}
        <ol className="absolute inset-y-0 left-12 right-0" aria-label="Cards with a time">
          {placed.map(({ card, top, bar, lane, lanes }) => {
            const colour = colours.get(card.producer)!;
            return (
              <li
                key={card.id}
                className="absolute"
                style={{ top, left: `${(lane / lanes) * 100}%`, width: `${100 / lanes}%`, height: Math.max(bar, LABEL_PX) }}
                data-rail-entry={card.id}
                data-span={bar > 0 ? '' : undefined}
              >
                {bar > 0 ? (
                  <span className="absolute left-0 top-0 w-1 rounded-full" style={{ height: bar, background: colour }} aria-hidden />
                ) : (
                  <span className="absolute -left-[3px] top-[3px] size-2.5 rounded-full" style={{ background: colour }} aria-hidden />
                )}
                {entry(card)}
              </li>
            );
          })}
        </ol>
      </div>
      {legend}
    </div>
  );
}
