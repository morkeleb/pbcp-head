'use client';

// UpdateRow: an artifact or signal, or a thread of them (cards sharing producer and thread, newest last, §8), as a
// row of the reference UI. The iOS app mirrors this component; it is self-contained: a thread in, acknowledgement out.
//
//   PRODUCER · LABEL · 09:15–09:30 · acknowledge · source host ↗                          Acknowledge
//   Title                     (the newest card's)
//   lead                      (the newest card's rendered_lead)
//   [first diagram or image, fitted to the row, captioned; opens full-screen at native size]
//   2 earlier in this thread ⌄   → each earlier card by time and title, then the newest, newest last
//
// The row says what the card wants (acknowledge) and never what kind it is (§4.1a). Acknowledging (a tap now; a swipe
// after the undo window) acknowledges every card in the thread (§4.2) and turns the control into "Acknowledged · 09:14".

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useImperativeHandle, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { api, cardHref, OfflineError, useOnline } from '../client';
import { announce, NOT_SENT, Rendered, useDeferred, useLocale, useSwipe, type MeCard } from '../components';
import { CardMeta, clock, Thumbnail, wants } from './card-parts';
import { rowId } from './days';

/** A thread on the brief: its newest card in full, and the earlier ones by title. */
export interface UpdateThread {
  latest: MeCard;
  earlier: Array<{ id: string; title: string; received_at: string; kind?: string; acknowledged_at?: string }>;
}

export interface UpdateRowHandle {
  /** `enter`: open the card. */
  open(): void;
}

export interface UpdateRowProps {
  thread: UpdateThread;
  timezone: string;
  /** After the head acknowledged (`at`), or with null when it refused and the row is back as it was. */
  onAcknowledged?: (ids: string[], at: string | null) => void;
  focused?: boolean;
  handle?: Ref<UpdateRowHandle>;
  /** The card page: the whole body, rendered, in place of the lead and the first visual; the thread is the page's. */
  expanded?: boolean;
}

export function UpdateRow({ thread, timezone, onAcknowledged, focused, handle, expanded = false }: UpdateRowProps) {
  const c = thread.latest;
  const locale = useLocale();
  const cards = [c, ...thread.earlier];
  const ids = cards.map((x) => x.id);
  const done = cards.every((x) => x.acknowledged_at);
  const last = cards.map((x) => x.acknowledged_at).filter(Boolean).sort().at(-1);
  const [acked, setAcked] = useState<string | null>(done ? (last ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();
  const deferred = useDeferred();
  const swipe = useSwipe(() => {
    if (!acked && online && !deferred.pending) deferred.schedule(`Acknowledge: ${c.title}`, () => void ack());
  });
  useImperativeHandle(handle, () => ({ open: () => void (location.href = cardHref(c.id)) }));

  const ack = async () => {
    setError(null);
    const now = new Date().toISOString();
    setAcked(now);
    onAcknowledged?.(ids, now);
    announce(`Acknowledged: ${c.title}`);
    try {
      let at: string | undefined;
      for (const x of cards) {
        if (x.acknowledged_at) continue;
        const r = await api<{ acknowledged_at?: string; message?: string }>(`/api/me/cards/${encodeURIComponent(x.id)}/ack`, { method: 'POST' });
        if (r.status !== 200) throw new Error(r.body?.message ?? `the head answered ${r.status}`);
        at = r.body.acknowledged_at ?? at;
      }
      if (at) {
        setAcked(at);
        onAcknowledged?.(ids, at);
      }
    } catch (e) {
      setAcked(null);
      onAcknowledged?.(ids, null);
      const message = e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed';
      setError(message);
      announce(`Not acknowledged: ${message}`);
    }
  };

  // What the row still wants: the newest card's, or an earlier one's not yet acknowledged.
  const want = acked ? null : (wants(c) ?? (thread.earlier.some((e) => !e.acknowledged_at) ? 'acknowledge' : null));
  return (
    <article
      id={expanded ? undefined : rowId(c.id)}
      data-card={c.id}
      data-kind={c.kind}
      tabIndex={-1}
      className={cn('update-row relative scroll-mt-[calc(var(--masthead-h,0px)+12px)] touch-pan-y py-3 outline-none transition-transform duration-150', focused && 'ring-2 ring-ring rounded-md')}
      style={swipe.dx ? { transform: `translateX(${swipe.dx / 3}px)` } : undefined}
      ref={swipe.ref}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <CardMeta card={c} timezone={timezone} want={want} />
          <h4 className="mt-0.5 font-serif text-title font-semibold tracking-editorial">
            <Link href={cardHref(c.id)} className="hover:underline">{c.title}</Link>
          </h4>
          {!expanded && c.rendered_lead && <p className="lead mt-0.5 text-lead text-muted-foreground" dangerouslySetInnerHTML={{ __html: c.rendered_lead }} />}
        </div>
        <div className="flex-none pt-3">
          {acked ? (
            <span className="state-line text-meta text-muted-foreground" role="status">Acknowledged · {clock(acked, timezone, locale)}</span>
          ) : (
            <Button size="xs" variant="outline" disabled={!online} onClick={() => void ack()}>Acknowledge</Button>
          )}
        </div>
      </div>
      {expanded && <Rendered className="mt-2 text-body" html={c.rendered_html} />}
      {!expanded && c.first_visual && <Thumbnail visual={c.first_visual} />}
      {!expanded && thread.earlier.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group mt-1 flex items-center gap-1 text-lead text-muted-foreground">
            {thread.earlier.length} earlier in this thread <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            {/* The thread, newest last (§8): the earlier cards, then the newest, which the row shows above. */}
            <ol className="mt-1 space-y-0.5 text-lead" data-thread>
              {[...thread.earlier, c].map((e) => (
                <li key={e.id} className="truncate">
                  <span className="tabular-nums text-muted-foreground">{clock(e.received_at, timezone, locale)}</span>{' '}
                  <Link href={cardHref(e.id)} className="hover:underline">{e.title}</Link>
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      )}
      {error && <p className="mt-1 text-lead text-destructive" role="alert">{error}</p>}
      {deferred.toast}
    </article>
  );
}
