'use client';

// DecisionCard: one open (or just decided) decision card, as the reference UI presents it (RFC 0.6 §4.5). The iOS app
// mirrors this component; it is self-contained: a card in, changes out.
//
//   producer · time · source ↗   (an accent dot while unseen)               ⋮ snooze or unsnooze, open card, delegate
//   Title, in the serif
//   lead (rendered_lead: the summary as text, else the first paragraph)
//   ┌ Proposal (the first heading beginning "Proposal"/"Proposed", any level) ┐
//   More (the rest of the body; opening it sets seen_at)
//   [Default]  [Other]  [Edit…]  Dismiss          Add a comment
//
// A tap commits at once and the buttons give way to a state line ("Approved · 09:14"). A swipe (touch or pen) or a
// key (via `handle`) waits behind a 4 s undo. Ledger density folds the card to one line that expands.

import { ChevronDown, EllipsisVertical } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { api, cardHref, OfflineError, useOnline } from '../client';
import {
  announce, decidedLine, NOT_SENT, OFFLINE_REASON_SHORT, options, Rendered, SourceLink, sourceLink, splitBody, swipeChoice, useDecide, useDeferred, useSwipe,
  type MeCard,
} from '../components';

export type Density = 'comfortable' | 'ledger';

/** What the composition can do to a card from the keyboard (j/k/enter/d) or elsewhere. */
export interface DecisionCardHandle {
  /** `d`: dismiss, after the same undo window as a swipe. */
  dismiss(): void;
  /** `enter`: open the rest of the body (or, folded in ledger, the card). */
  expand(): void;
}

export interface DecisionCardProps {
  card: MeCard;
  /** The day's timezone, for times. */
  timezone: string;
  density: Density;
  /** Every change to the card: optimistic, confirmed, or rolled back. */
  onChange: (card: MeCard) => void;
  /** Shown as the keyboard's current card (broadsheet). */
  focused?: boolean;
  /** The time in the header; off on the timeline, whose rail carries it. */
  showTime?: boolean;
  /** The card page: the whole body open (lead, proposal and the rest), decided or not; no "More". */
  expanded?: boolean;
  handle?: Ref<DecisionCardHandle>;
}

const SNOOZES = [
  { preset: 'tonight', label: 'Tonight' },
  { preset: 'tomorrow', label: 'Tomorrow’s brief' },
  { preset: 'next-week', label: 'Next week' },
] as const;

/** A time on the brief: 24-hour in every locale ("Approved · 09:14"), in the head's timezone. */
export const clock = (iso: string, timeZone?: string) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(iso));

export function DecisionCard({ card, timezone, density, onChange, focused, handle, showTime = true, expanded = false }: DecisionCardProps) {
  const { list, edit, byDefault } = options(card);
  const grouped = list.some((o) => o.hasBody || !!card.rendered_actions?.[o.id]);
  const online = useOnline();
  const decided = card.state === 'decided';
  const [selected, setSelected] = useState<string>(byDefault?.id ?? '');
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState('');
  const [comment, setComment] = useState('');
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(expanded || density === 'comfortable');
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const { decide: post, error } = useDecide(card, onChange);
  const decide = (decision: string, extra: { edited_proposal?: string } = {}) =>
    post({ decision, ...extra, ...(comment.trim() ? { comment: comment.trim() } : {}) });
  const deferred = useDeferred();
  const swipe = useSwipe((direction) => {
    const choice = decided || !online || deferred.pending ? null : swipeChoice(card, direction);
    if (choice) deferred.schedule(`${choice.label}: ${card.title}`, () => void decide(choice.decision));
  });
  useEffect(() => setOpen(expanded || density === 'comfortable'), [density, expanded]);

  // The proposal and the rest, from the body the head rendered (the lead is the head's: rendered_lead).
  const [parts, setParts] = useState<{ proposal: string; rest: string } | null>(null);
  useEffect(() => setParts(splitBody(card.rendered_html, card.lead_source === 'body')), [card.rendered_html, card.lead_source]);

  // Opening the rest of the body is what presents the card (§4.2 seen_at); the lead alone is not.
  const opened = useRef(false);
  const expandMore = (next: boolean) => {
    setMore(next);
    if (!next || opened.current) return;
    opened.current = true;
    if (!card.seen_at) {
      const at = new Date().toISOString();
      onChange({ ...card, seen_at: at });
      api(`/api/me/cards/${encodeURIComponent(card.id)}/seen`, { method: 'POST' }).catch(() => undefined);
    }
  };
  useImperativeHandle(handle, () => ({
    dismiss: () => {
      if (!decided && online && !deferred.pending) deferred.schedule(`Dismiss: ${card.title}`, () => void decide('dismissed'));
    },
    expand: () => (open ? expandMore(!more) : setOpen(true)),
  }));

  // `preset` null: unsnooze.
  const snooze = async (preset: string | null, label: string) => {
    setSnoozeError(null);
    try {
      const r = await api<MeCard & { message?: string }>(`/api/me/cards/${encodeURIComponent(card.id)}/${preset ? 'snooze' : 'unsnooze'}`, { method: 'POST', ...(preset ? { body: { preset } } : {}) });
      if (r.status !== 200) throw new Error(r.body?.message ?? `the head answered ${r.status}`);
      onChange({ ...card, ...r.body });
      announce(preset ? `Snoozed until ${label.toLowerCase()}: ${card.title}` : `Unsnoozed: ${card.title}`);
    } catch (e) {
      setSnoozeError(e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed');
    }
  };

  const meta = (
    <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-meta font-medium uppercase tracking-meta text-muted-foreground">
      {/* One line: the producer and time keep their room, the source's label truncates first (§4.1 `source`). */}
      <span className="max-w-[45%] flex-none truncate">{card.producer}</span>
      {showTime && <span aria-hidden>·</span>}
      {!card.seen_at && !decided && <span className="size-1.5 flex-none rounded-full bg-primary" aria-label="unseen" />}
      {showTime && <time className="flex-none" dateTime={card.received_at}>{clock(card.received_at, timezone)}</time>}
      {sourceLink(card.source) && (
        <>
          <span aria-hidden>·</span>
          <SourceLink source={card.source} />
        </>
      )}
    </div>
  );

  const kebab = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="-mr-2 -mt-1 text-muted-foreground" aria-label={`More actions: ${card.title}`}>
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="text-meta uppercase tracking-meta text-muted-foreground">Snooze</DropdownMenuLabel>
        {SNOOZES.map((s) => (
          <DropdownMenuItem key={s.preset} disabled={!online || decided} onSelect={() => void snooze(s.preset, s.label)}>{s.label}</DropdownMenuItem>
        ))}
        {card.snoozed_until && card.snoozed_until > new Date().toISOString() && (
          <DropdownMenuItem disabled={!online || decided} onSelect={() => void snooze(null, 'Unsnooze')}>Unsnooze</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={cardHref(card.id)}>Open card</Link>
        </DropdownMenuItem>
        {/* §4.5: `delegated` is offered only by a head that implements Appendix B; this head does not yet. */}
        <DropdownMenuItem disabled>Delegate… (not on this head)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const stateLine = decided && (
    <p className="state-line mt-3 text-lead text-muted-foreground" role="status">
      {decidedLine(card)}
      {card.decided_at && <> · {clock(card.decided_at, timezone)}</>}
    </p>
  );

  const chosen = list.find((o) => o.id === selected);
  const controls = !decided && (
    <div className="mt-3 space-y-2">
      {grouped && (
        <RadioGroup value={selected} onValueChange={setSelected} disabled={!online} aria-label="Options" className="gap-2">
          {list.map((o) => (
            <label key={o.id} className={cn('flex cursor-pointer gap-3 rounded-md border p-3', selected === o.id && 'border-ring')}>
              <RadioGroupItem value={o.id} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2 text-body font-medium">
                  {o.label}
                  {o.isDefault && <span className="text-meta font-normal uppercase tracking-meta text-muted-foreground">default</span>}
                </span>
                {card.rendered_actions?.[o.id] && <Rendered className="mt-1 text-lead text-muted-foreground" html={card.rendered_actions[o.id]!} />}
              </span>
            </label>
          ))}
        </RadioGroup>
      )}
      {editing && (
        <div className="space-y-1">
          <label className="text-lead text-muted-foreground" htmlFor={`edit-${card.id}`}>What you want instead</label>
          <textarea id={`edit-${card.id}`} rows={4} value={edited} onChange={(e) => setEdited(e.target.value)} autoFocus
            className="w-full rounded-md border border-input bg-background p-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
      )}
      <div className="decide-row flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button size="sm" disabled={!online || !edited.trim()} onClick={() => void decide('edited', { edited_proposal: edited.trim() })}>Send edit</Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Back</Button>
          </>
        ) : grouped ? (
          // One primary button records the choice; filled only when the card has a default (§4.5).
          <Button size="sm" variant={byDefault ? 'default' : 'outline'} disabled={!online || !chosen} onClick={() => chosen && void decide(chosen.id)}>
            {chosen ? chosen.label : 'Pick an option'}
          </Button>
        ) : (
          list.map((o) => (
            <Button key={o.id} size="sm" variant={o === byDefault ? 'default' : 'outline'} disabled={!online} onClick={() => void decide(o.id)}>
              {o.label}
            </Button>
          ))
        )}
        {!editing && edit && <Button size="sm" variant="outline" disabled={!online} onClick={() => setEditing(true)}>Edit…</Button>}
        {!editing && (
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={!online} onClick={() => void decide('dismissed')}>Dismiss</Button>
        )}
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
      {(error ?? snoozeError) && <p className="text-lead text-destructive" role="alert">{error ?? snoozeError}</p>}
    </div>
  );

  const body = (
    <>
      {card.rendered_lead && <p className="lead mt-1 text-lead text-muted-foreground" dangerouslySetInnerHTML={{ __html: card.rendered_lead }} />}
      {(expanded || !decided) && parts?.proposal && <Rendered className="proposal mt-3 rounded-md bg-inset px-3 py-2 text-body" html={parts.proposal} />}
      {expanded && parts?.rest.trim() && <Rendered className="more-body mt-3 text-body" html={parts.rest} />}
      {!expanded && !decided && parts?.rest.trim() && (
        <Collapsible open={more} onOpenChange={expandMore}>
          <CollapsibleTrigger className="more-trigger group mt-2 flex items-center gap-1 text-lead text-muted-foreground">
            More <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Rendered className="more-body mt-2 text-body" html={parts.rest} />
          </CollapsibleContent>
        </Collapsible>
      )}
      {stateLine}
      {controls}
    </>
  );

  return (
    <article
      data-card={card.id}
      data-kind="decision"
      tabIndex={-1}
      className={cn(
        'decision-card relative touch-pan-y rounded-lg border bg-card text-card-foreground outline-none transition-[opacity,transform] duration-150',
        density === 'ledger' ? 'px-3 py-2' : 'p-4 max-[899px]:p-3',
        decided && !expanded && 'opacity-72',
        focused && 'ring-2 ring-ring',
      )}
      style={swipe.dx ? { transform: `translateX(${swipe.dx / 3}px)` } : undefined}
      ref={swipe.ref}
    >
      {density === 'ledger' && !open ? (
        // Ledger: the title (never cut short) and the actions. On a phone the title has its own line and the actions the
        // next; on the broadsheet they share one. Every option is a control in place, choice lists included (§4.5): no
        // "Choose…" in front of them. Tapping the title opens the card.
        <div className="ledger-line flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button className="ledger-title min-w-0 basis-full text-left min-[900px]:flex-1 min-[900px]:basis-0" onClick={() => setOpen(true)} aria-expanded={false}>
            <span className="mr-2 text-meta font-medium uppercase tracking-meta text-muted-foreground">{card.producer}</span>
            <span className="font-serif text-body font-semibold break-words">{card.title}</span>
            {card.rendered_lead && (
              <span className="hidden text-lead text-muted-foreground min-[900px]:inline">
                {' '}— <span dangerouslySetInnerHTML={{ __html: card.rendered_lead }} />
              </span>
            )}
          </button>
          {decided ? (
            <span className="text-lead text-muted-foreground">{decidedLine(card)}{card.decided_at && <> · {clock(card.decided_at, timezone)}</>}</span>
          ) : (
            <div className="decide-row flex flex-wrap items-center gap-1">
              {list.map((o) => (
                <Button key={o.id} size="xs" variant={o === byDefault ? 'default' : 'outline'} disabled={!online} onClick={() => void decide(o.id)}>{o.label}</Button>
              ))}
              <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={!online} onClick={() => void decide('dismissed')}>Dismiss</Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            {meta}
            {kebab}
          </div>
          <h3 className={cn('font-serif font-semibold tracking-editorial text-card-foreground', density === 'ledger' ? 'text-body' : 'text-title')}>
            <Link href={cardHref(card.id)} className="hover:underline">{card.title}</Link>
          </h3>
          {body}
          {density === 'ledger' && !expanded && (
            <button className="mt-2 text-lead text-muted-foreground" onClick={() => setOpen(false)}>Fold</button>
          )}
        </>
      )}
      {deferred.toast}
    </article>
  );
}

