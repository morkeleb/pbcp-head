'use client';

// DecisionCard: one decision card as the reference UI presents it (RFC 0.8 §4.5), wherever it is presented: a row of the
// brief, and the card page. The iOS app mirrors this component; it is self-contained: a card in, changes out.
//
//   producer · labels · 09:15–09:30 · decide · source host ↗   (an accent dot while unseen)       ⋮ snooze, open card
//   Title, in the serif
//   lead (rendered_lead: the summary as text, else the first paragraph)
//   ┌ Proposal (the first heading beginning "Proposal"/"Proposed", any level) ┐
//   [first visual]  More (the rest of the body; opening it sets seen_at)
//   [Default]  [Other]  [Edit…]  Dismiss          Add a comment
//
// Every action is a control on the row, in the card's order, with no gesture before it; the default is the one primary
// control, and with no default none is. Options that carry a body are laid out one under another, each with its own
// control beside its body. A tap commits at once and the controls give way to a state line ("Approved · 09:14"), with
// the later cards that reference the card beside it (§8: "Sent: Re: invoice timing · 08:11"). A key (via `handle`)
// waits behind a 4 s undo. A sideways swipe is not the card's: it moves the brief between days.

import { ChevronDown, EllipsisVertical } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { api, cardHref, OfflineError, useOnline } from '../client';
import {
  announce, decidedLine, useLocale, NOT_SENT, OFFLINE_REASON_SHORT, options, Rendered, splitBody, useDecide, useDeferred,
  type MeCard,
} from '../components';
import { CardMeta, clock, Thumbnail, wants } from './card-parts';
import { rowId } from './days';

export { clock };

/** What the page can do to a card from the keyboard (j/k/enter/d) or elsewhere. */
export interface DecisionCardHandle {
  /** `d`: dismiss, after an undo window. */
  dismiss(): void;
  /** `enter`: open the rest of the body. */
  expand(): void;
}

export interface DecisionCardProps {
  card: MeCard;
  /** The head's timezone, for times. */
  timezone: string;
  /** Every change to the card: optimistic, confirmed, or rolled back. */
  onChange: (card: MeCard) => void;
  /** Shown as the keyboard's current card. */
  focused?: boolean;
  /** The time in the header. */
  showTime?: boolean;
  /** The card page: the whole body open (lead, proposal and the rest), decided or not; no "More". */
  expanded?: boolean;
  /** A decision whose day (§8) is not the day it is shown under: "for Fri 31 Oct" in the header. */
  forDay?: string;
  /** The later cards that reference this one, paired with its decision (§8). */
  paired?: MeCard[];
  handle?: Ref<DecisionCardHandle>;
}

const SNOOZES = [
  { preset: 'tonight', label: 'Tonight' },
  { preset: 'tomorrow', label: 'Tomorrow’s brief' },
  { preset: 'next-week', label: 'Next week' },
] as const;

export function DecisionCard({ card, timezone, onChange, focused, handle, showTime = true, expanded = false, forDay, paired = [] }: DecisionCardProps) {
  const { list, edit, byDefault } = options(card);
  const withBodies = list.some((o) => o.hasBody || !!card.rendered_actions?.[o.id]);
  const online = useOnline();
  const locale = useLocale();
  const decided = card.state === 'decided';
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState('');
  const [comment, setComment] = useState('');
  const [more, setMore] = useState(false);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const { decide: post, error } = useDecide(card, onChange);
  const decide = (decision: string, extra: { edited_proposal?: string } = {}) =>
    post({ decision, ...extra, ...(comment.trim() ? { comment: comment.trim() } : {}) });
  const deferred = useDeferred();

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
    expand: () => expandMore(!more),
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
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // §4.5 confirmation: the decision recorded, in words and time, in place of the controls; §8 the later cards that
  // reference the card, beside it.
  const stateLine = decided && (
    <div className="state-line mt-3 text-lead text-muted-foreground" role="status">
      <span>{decidedLine(card)}{card.decided_at && <> · {clock(card.decided_at, timezone, locale)}</>}</span>
      {paired.length > 0 && (
        <ul className="contents" data-paired>
          {paired.map((p) => (
            <li key={p.id} className="inline">
              {' · '}
              <Link href={cardHref(p.id)} className="text-foreground hover:underline">{p.title}</Link> {clock(p.received_at, timezone, locale)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const control = (o: (typeof list)[number]) => (
    <Button key={o.id} size="sm" variant={o === byDefault ? 'default' : 'outline'} disabled={!online} onClick={() => void decide(o.id)} data-action={o.id} {...(o === byDefault ? { 'data-primary': '' } : {})}>
      {o.label}
    </Button>
  );
  const controls = !decided && (
    <div className="mt-3 space-y-2">
      {withBodies && !editing && (
        // Options that carry a body: one under another, each its own control beside what it costs (§4.4, §4.5).
        <ul className="space-y-2" aria-label="Options" data-options>
          {list.map((o) => (
            // Its body beside the button where there is room, under it where there is not (never a word-wide column).
            <li key={o.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border p-2.5">
              <span className="max-w-full flex-none">{control(o)}</span>
              {card.rendered_actions?.[o.id] && <Rendered className="min-w-[12rem] flex-1 pt-1 text-lead text-muted-foreground" html={card.rendered_actions[o.id]!} />}
            </li>
          ))}
        </ul>
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
        ) : (
          <>
            {!withBodies && list.map(control)}
            {edit && <Button size="sm" variant="outline" disabled={!online} onClick={() => setEditing(true)} data-action="edit">Edit…</Button>}
            <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={!online} onClick={() => void decide('dismissed')} data-action="dismissed">Dismiss</Button>
          </>
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

  return (
    <article
      id={expanded ? undefined : rowId(card.id)}
      data-card={card.id}
      data-kind="decision"
      tabIndex={-1}
      className={cn(
        'decision-card relative scroll-mt-[calc(var(--masthead-h,0px)+12px)] rounded-lg border bg-card p-4 text-card-foreground outline-none transition-[opacity,transform] duration-150 max-[899px]:p-3',
        decided && !expanded && 'opacity-80',
        focused && 'ring-2 ring-ring',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <CardMeta
          card={card} timezone={timezone} showTime={showTime} want={wants(card)} unseen={!card.seen_at && !decided}
          extra={forDay && <span className="flex-none normal-case tracking-normal" data-for-day>· for {forDay}</span>}
        />
        {kebab}
      </div>
      <h3 className="font-serif text-title font-semibold tracking-editorial text-card-foreground">
        <Link href={cardHref(card.id)} className="hover:underline">{card.title}</Link>
      </h3>
      {card.rendered_lead && <p className="lead mt-1 text-lead text-muted-foreground" dangerouslySetInnerHTML={{ __html: card.rendered_lead }} />}
      {(expanded || !decided) && parts?.proposal && <Rendered className="proposal mt-3 rounded-md bg-inset px-3 py-2 text-body" html={parts.proposal} />}
      {expanded && parts?.rest.trim() && <Rendered className="more-body mt-3 text-body" html={parts.rest} />}
      {!expanded && !decided && !more && card.first_visual && <Thumbnail visual={card.first_visual} />}
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
      {deferred.toast}
    </article>
  );
}
