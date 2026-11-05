'use client';

// TaskRow: a task (RFC 0.9 §4.1, §4.5 "Presenting a task") as a checklist row of the brief's Tasks section, and, opened,
// as the full card, in place or on the card page.
//
//   ○  17:00  Renew the passport — Form and photo at the town hall.            errands · todoist.com ↗
//
// The circle is the task's primary control: a tap records `done` at once (§4.3) and the row stays, ticked and dimmed, for
// the rest of the day. A swipe right is done, a swipe left dismisses, each behind the 4 s undo; the swipe is the row's,
// not the brief's (it does not move between days). A tap on the line opens the card in place: the body, Done (the one
// primary control), the task's listed actions beside it as outlined controls in the card's order, Dismiss, the comment
// behind a disclosure, and the menu (snooze, open card). A task the producer closed (§4.3: superseded by its record of
// what came of it, "Done in Todoist") shows ticked with that record's title. The row says what it wants (do), never the
// kind's name (§4.1a); the day's list of them is headed "Tasks", as the brief's paragraph says them.

import { ArrowUpRight, Check, ChevronDown, EllipsisVertical } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { dueDay } from '../../../lib/brief/tasks';
import { addDays, instant, localDate } from '../../../lib/time';
import { api, cardHref, OfflineError, useOnline } from '../client';
import {
  announce, CardLabels, decidedLine, NOT_SENT, OFFLINE_REASON_SHORT, options, Rendered, SourceLink, sourceLink, splitBody, useDecide, useDeferred, useLocale, useSwipe,
  type MeCard,
} from '../components';
import { CardMeta, clock, wants } from './card-parts';
import { rowId, shortDay } from './days';

export interface TaskRowHandle {
  /** `d`: dismiss, after the undo window. */
  dismiss(): void;
  /** `enter`: open or close the card in place. */
  expand(): void;
}

export interface TaskRowProps {
  card: MeCard;
  timezone: string;
  /** The head's today, YYYY-MM-DD: "today" and "tomorrow" are said against it. */
  today: string;
  onChange: (card: MeCard) => void;
  /** Listed under "Overdue": its due day is always said (§4.5: marked as overdue). */
  overdue?: boolean;
  focused?: boolean;
  handle?: Ref<TaskRowHandle>;
  /** The card page: opened, and not a row. */
  expanded?: boolean;
}

const SNOOZES = [
  { preset: 'tonight', label: 'Tonight' },
  { preset: 'tomorrow', label: 'Tomorrow’s brief' },
  { preset: 'next-week', label: 'Next week' },
] as const;

/**
 * When the task is due, as the row says it (§4.5: visible): its `at` as a time ("17:00", with the day when that is not
 * today, or when it is overdue), or its `about` day ("today", "tomorrow", "Mon 3 Nov"); nothing with neither.
 */
export function dueLabel(card: Pick<MeCard, 'at' | 'about'>, today: string, timezone: string, locale: string | undefined, overdue = false): string | null {
  const day = card.at ? localDate(instant(card.at), timezone) : dueDay(card, timezone);
  const named = (d: string) => (overdue ? shortDay(d) : d === today ? 'today' : d === addDays(today, 1) ? 'tomorrow' : shortDay(d));
  if (card.at) return day === today && !overdue ? clock(card.at, timezone, locale) : `${shortDay(day!)} ${clock(card.at, timezone, locale)}`;
  return day ? named(day) : null;
}

/** The task is closed and that counts as done: decided `done`, or closed by its producer with a record of it (§4.3). */
export const isDone = (c: MeCard) => c.decision === 'done' || (c.state === 'superseded' && !c.decision && !!c.replaced_by);

export function TaskRow({ card, timezone, today, onChange, overdue = false, focused, handle, expanded = false }: TaskRowProps) {
  const locale = useLocale();
  const online = useOnline();
  const open = card.state === 'open';
  const done = isDone(card);
  const [opened, setOpened] = useState(expanded);
  const [comment, setComment] = useState('');
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const { list } = options(card);
  const { decide: post, error, notice } = useDecide(card, onChange);
  const decide = (decision: string) => post({ decision, ...(comment.trim() ? { comment: comment.trim() } : {}) });
  // A swipe waiting out its undo window still happens if the row leaves the screen (another day, a card opened).
  const deferred = useDeferred({ commitOnUnmount: true });
  const later = (decision: 'done' | 'dismissed') => {
    if (open && online && !deferred.pending) deferred.schedule(`${decision === 'done' ? 'Done' : 'Dismiss'}: ${card.title}`, () => void decide(decision));
  };
  const swipe = useSwipe((direction) => !expanded && later(direction === 'right' ? 'done' : 'dismissed'));

  // Opening the card is what presents it (§4.2 seen_at).
  const seen = useRef(false);
  const toggle = (next = !opened) => {
    setOpened(next);
    if (!next || seen.current || card.seen_at) return;
    seen.current = true;
    onChange({ ...card, seen_at: new Date().toISOString() });
    api(`/api/me/cards/${encodeURIComponent(card.id)}/seen`, { method: 'POST' }).catch(() => undefined);
  };
  useEffect(() => void (expanded && setOpened(true)), [expanded]);
  useImperativeHandle(handle, () => ({ dismiss: () => later('dismissed'), expand: () => toggle() }));

  const snooze = async (preset: string, label: string) => {
    setSnoozeError(null);
    try {
      const r = await api<MeCard & { message?: string }>(`/api/me/cards/${encodeURIComponent(card.id)}/snooze`, { method: 'POST', body: { preset } });
      if (r.status !== 200) throw new Error(r.body?.message ?? `the head answered ${r.status}`);
      onChange({ ...card, ...r.body });
      announce(`Snoozed until ${label.toLowerCase()}: ${card.title}`);
    } catch (e) {
      setSnoozeError(e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed');
    }
  };

  // The body without its lead, which the row already shows (§3.1); a task has no proposal to set apart (§4.5).
  const [body, setBody] = useState(card.rendered_html);
  useEffect(() => {
    const { proposal, rest } = splitBody(card.rendered_html, card.lead_source === 'body');
    setBody(proposal + rest);
  }, [card.rendered_html, card.lead_source]);
  const due = dueLabel(card, today, timezone, locale, overdue && open);
  const link = sourceLink(card.source);
  // What closed it, in the lead's place: the producer's record ("Done in Todoist"), or the decision and its time.
  const closed = !open && (card.state === 'superseded' && card.replaced_by && !card.decision
    ? card.replaced_by.title
    : `${decidedLine(card)}${card.decided_at ? ` · ${clock(card.decided_at, timezone, locale)}` : ''}`);

  const circle = (
    <button
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Done: ${card.title}` : `Mark done: ${card.title}`}
      disabled={!open || !online || !!deferred.pending}
      onClick={() => void decide('done')}
      data-done-control
      data-primary
      className={cn(
        'flex size-[1.375rem] flex-none items-center justify-center rounded-full border-2 transition-colors',
        done ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/60 hover:border-primary',
        open && 'disabled:opacity-50',
      )}
    >
      {done && <Check className="size-3.5" strokeWidth={3} aria-hidden />}
    </button>
  );

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="-mr-2 text-muted-foreground" aria-label={`More actions: ${card.title}`}>
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="text-meta uppercase tracking-meta text-muted-foreground">Snooze</DropdownMenuLabel>
        {SNOOZES.map((s) => (
          <DropdownMenuItem key={s.preset} disabled={!online || !open} onSelect={() => void snooze(s.preset, s.label)}>{s.label}</DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={cardHref(card.id)}>Open card</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Offline, or a swipe's decision still waiting out its undo: nothing else is sent meanwhile.
  const busy = !online || !!deferred.pending;
  // §4.5: Done the one primary control; the listed actions beside it, outlined, in the card's order; Dismiss secondary.
  const controls = open && (
    <div className="mt-3 space-y-2">
      <div className="decide-row flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('done')} data-action="done" data-primary>Done</Button>
        {list.map((o) => (
          <Button key={o.id} size="sm" variant="outline" disabled={busy} onClick={() => void decide(o.id)} data-action={o.id}>{o.label}</Button>
        ))}
        <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void decide('dismissed')} data-action="dismissed">Dismiss</Button>
      </div>
      <Collapsible className="comment">
        <CollapsibleTrigger className="group flex items-center gap-1 text-lead text-muted-foreground">
          Add a comment <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" disabled={!online}
            className="mt-1 w-full rounded-md border border-input bg-background p-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </CollapsibleContent>
      </Collapsible>
      {!online && <p className="offline text-lead text-muted-foreground" role="status">{OFFLINE_REASON_SHORT}</p>}
    </div>
  );

  const told = notice && <p className="mt-2 text-lead text-destructive" role="alert" data-decide-notice>{notice}</p>;
  const failed = (error ?? snoozeError) && <p className="mt-1 text-lead text-destructive" role="alert">{error ?? snoozeError}</p>;

  if (expanded) {
    // The card page: the header line, the title, the lead and the whole body, then the controls (§4.5).
    return (
      <article data-card={card.id} data-kind="task" className="rounded-lg border bg-card p-4 text-card-foreground max-[899px]:p-3">
        <div className="flex items-start justify-between gap-2">
          <CardMeta card={card} timezone={timezone} want={wants(card)} extra={due && <span className="flex-none normal-case tracking-normal" data-due>· due {due}</span>} />
          {menu}
        </div>
        <div className="mt-1 flex items-start gap-3">
          <span className="pt-1">{circle}</span>
          <div className="min-w-0 flex-1">
            <h3 className={cn('font-serif text-title font-semibold tracking-editorial', done && 'text-muted-foreground line-through decoration-1')}>{card.title}</h3>
            {card.rendered_lead && <p className="lead mt-1 text-lead text-muted-foreground" dangerouslySetInnerHTML={{ __html: card.rendered_lead }} />}
          </div>
        </div>
        {body.trim() && <Rendered className="mt-3 text-body" html={body} />}
        {closed && <p className="state-line mt-3 text-lead text-muted-foreground" role="status" data-task-closed>{closed}</p>}
        {told}
        {controls}
        {failed}
      </article>
    );
  }

  return (
    <article
      id={rowId(card.id)}
      ref={swipe.ref}
      data-card={card.id}
      data-kind="task"
      data-swipes
      tabIndex={-1}
      style={swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined}
      className={cn(
        'task-row relative scroll-mt-[calc(var(--masthead-h,0px)+12px)] py-2 outline-none transition-opacity',
        !open && 'opacity-60',
        focused && 'rounded-md ring-2 ring-ring',
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {circle}
        <button
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          onClick={() => toggle()}
          aria-expanded={opened}
          aria-label={`${card.title}${due ? `, due ${due}` : ''}${overdue && open ? ', overdue' : ''}`}
          data-task-line
        >
          {due && <span className={cn('flex-none text-meta tabular-nums', overdue && open ? 'text-destructive' : 'text-muted-foreground')} data-due>{due}</span>}
          <span className="min-w-0 truncate">
            <span className={cn('font-medium', done && 'line-through decoration-1')}>{card.title}</span>
            {closed ? (
              <span className="text-muted-foreground" data-task-closed> — {closed}</span>
            ) : (
              card.rendered_lead && <span className="text-muted-foreground"> — <span dangerouslySetInnerHTML={{ __html: card.rendered_lead }} /></span>
            )}
          </span>
        </button>
        {/* The first label, small, and the source: its host where there is room, its arrow alone on a phone (the title first). */}
        <span className="flex max-w-[35%] flex-none items-center gap-2 whitespace-nowrap text-meta text-muted-foreground [&>[aria-hidden]:first-child]:hidden [&_[data-labels]]:max-w-[5.5rem]">
          <CardLabels labels={card.labels} first />
          {link && <SourceLink source={card.source} className="max-[599px]:hidden" />}
          {link && (
            <a href={link.href} target="_blank" rel="noopener" title={link.host} aria-label={`${link.label ? `${link.label}, ` : ''}${link.host} (opens in a new tab)`} className="min-[600px]:hidden hover:text-foreground" data-source-icon>
              <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
          )}
        </span>
      </div>
      {opened && (
        <div className="ml-[2.0rem] pb-1" data-task-open>
          <div className="flex items-start justify-between gap-2 pt-1">
            <CardMeta card={card} timezone={timezone} want={wants(card)} />
            {menu}
          </div>
          {body.trim() && <Rendered className="mt-1 text-body" html={body} />}
          {controls}
        </div>
      )}
      {told}
      {failed}
      {deferred.toast}
    </article>
  );
}
