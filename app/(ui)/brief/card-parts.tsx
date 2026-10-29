'use client';

// What every card row on the brief carries, for DecisionCard and UpdateRow alike: its header line (producer, labels, the
// card's time, what it wants of the person, the source and its host), and the one thumbnail a folded row shows.

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { instant } from '../../../lib/time';
import { CardLabels, SourceLink, sourceLink, themedSrc, useDark, useLocale, Viewer, type MeCard } from '../components';
import { localDay, shortDay } from './days';

/** A time on the brief: 24-hour in every locale ("Approved · 09:14"), in the head's timezone. */
export const clock = (iso: string, timeZone?: string, locale?: string) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(instant(iso));

/**
 * The card's time (§4.1, §8): `at`, or `at`–`until`, in the head's timezone, with the day when it is not the card's own
 * day ("09:15–09:30", "Fri 31 Oct 14:00", "23:00 – Sat 1 Nov 01:00"). Without `at`, when the head received it.
 */
export function cardTime(card: Pick<MeCard, 'at' | 'until' | 'received_at' | 'day'>, timezone: string, locale?: string): { text: string; dateTime: string } {
  if (!card.at) return { text: clock(card.received_at, timezone, locale), dateTime: card.received_at };
  const startDay = localDay(instant(card.at).toISOString(), timezone);
  const start = `${card.day && startDay !== card.day ? `${shortDay(startDay)} ` : ''}${clock(card.at, timezone, locale)}`;
  if (!card.until) return { text: start, dateTime: card.at };
  const endDay = localDay(instant(card.until).toISOString(), timezone);
  return { text: endDay === startDay ? `${start}–${clock(card.until, timezone, locale)}` : `${start} – ${shortDay(endDay)} ${clock(card.until, timezone, locale)}`, dateTime: card.at };
}

/** What the card wants of the person, in their words (§4.1a: never the kind's name): decide, acknowledge, or nothing. */
export function wants(card: MeCard): 'decide' | 'acknowledge' | null {
  if (card.kind === 'decision') return card.state === 'open' ? 'decide' : null;
  if (card.kind === 'artifact' || card.kind === 'signal') return card.state === 'open' && !card.acknowledged_at ? 'acknowledge' : null;
  return null;
}

/**
 * The header line: producer · labels · time · what it wants · source and host. One line: the source's label gives way
 * first, then the labels truncate; the producer, the time and the host keep their room (§4.1 `labels`, `source`, §12).
 */
export function CardMeta({ card, timezone, showTime = true, want, extra, unseen }: {
  card: MeCard; timezone: string; showTime?: boolean; want: 'decide' | 'acknowledge' | null; extra?: ReactNode; unseen?: boolean;
}) {
  const locale = useLocale();
  const time = cardTime(card, timezone, locale);
  return (
    <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-meta font-medium uppercase tracking-meta text-muted-foreground" data-meta>
      <span className="max-w-[45%] flex-none truncate" data-producer>{card.producer}</span>
      <CardLabels labels={card.labels} />
      {extra}
      {showTime && (
        // The subject's time (`at`) always; when the head received it only where there is room: it is the head's, not the card's.
        <span className={cn('flex flex-none items-center gap-2', !card.at && 'max-[899px]:hidden')}>
          <span aria-hidden>·</span>
          <time className="normal-case tracking-normal tabular-nums" dateTime={time.dateTime} data-card-time>{time.text}</time>
        </span>
      )}
      {unseen && <span className="size-1.5 flex-none rounded-full bg-primary" aria-label="unseen" />}
      {want && (
        <>
          <span aria-hidden>·</span>
          <span className="flex-none text-foreground" data-wants={want}>{want}</span>
        </>
      )}
      {sourceLink(card.source) && (
        <>
          <span aria-hidden>·</span>
          <SourceLink source={card.source} />
        </>
      )}
    </div>
  );
}

/**
 * §3.1: in a folded row, at most the card's first visual, fitted to the width, never cropped, captioned; a click opens it
 * full-screen at native size.
 */
export function Thumbnail({ visual }: { visual: NonNullable<MeCard['first_visual']> }) {
  const [viewing, setViewing] = useState(false);
  const dark = useDark();
  return (
    <figure className="mt-2" data-thumbnail>
      <button className="block w-full cursor-zoom-in" onClick={() => setViewing(true)} aria-label={`Open ${visual.caption || 'the visual'} full-screen`}>
        {/* A fixed box, so the page does not move when the image arrives; contained, so it is never cropped. */}
        <img
          src={themedSrc(visual.src, dark)}
          alt={visual.caption}
          loading="lazy"
          // A light drawing gets white behind it; a dark one carries its own ground (the dark card colour).
          className={cn('block h-44 w-full rounded-sm border object-contain', dark && visual.kind === 'diagram' ? 'bg-card' : 'bg-white')}
        />
      </button>
      {visual.caption && <figcaption className="mt-1 text-meta text-muted-foreground">{visual.caption}</figcaption>}
      {viewing && <Viewer visual={{ src: visual.src, caption: visual.caption }} onClose={() => setViewing(false)} />}
    </figure>
  );
}
