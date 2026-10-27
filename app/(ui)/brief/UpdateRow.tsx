'use client';

// UpdateRow: an artifact or signal, or a thread of them (cards sharing producer and thread, newest last, §8), as a
// row of the reference UI. The iOS app mirrors this component; it is self-contained: a thread in, acknowledgement out.
//
//   ▢ PRODUCER · 09:14                                              Acknowledge
//   Title
//   lead (rendered_lead)
//   [first diagram or image, fitted to the row, captioned; opens full-screen at native size or larger]
//   2 earlier: Title · Title
//
// Acknowledging (a tap now; a swipe after the undo window) acknowledges every card in the thread (§4.2) and turns the
// control into "Acknowledged · 09:14". Ledger density drops the lead line.

import { Bell, ChevronDown, FileText } from 'lucide-react';
import Link from 'next/link';
import { useImperativeHandle, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { api, cardHref, OfflineError, useOnline } from '../client';
import { announce, NOT_SENT, useDeferred, useSwipe, Viewer, type MeCard } from '../components';
import { clock, type Density } from './DecisionCard';

/** A thread on the brief: its newest card in full, and the earlier ones by title. */
export interface UpdateThread {
  latest: MeCard;
  earlier: Array<{ id: string; title: string; received_at: string; acknowledged_at?: string }>;
}

export interface UpdateRowHandle {
  /** `enter`: open the card. */
  open(): void;
}

export interface UpdateRowProps {
  thread: UpdateThread;
  timezone: string;
  density: Density;
  /** After the head acknowledged (`at`), or with null when it refused and the row is back as it was. */
  onAcknowledged?: (ids: string[], at: string | null) => void;
  focused?: boolean;
  handle?: Ref<UpdateRowHandle>;
}

export function UpdateRow({ thread, timezone, density, onAcknowledged, focused, handle }: UpdateRowProps) {
  const c = thread.latest;
  const cards = [c, ...thread.earlier];
  const ids = cards.map((x) => x.id);
  const done = cards.every((x) => x.acknowledged_at);
  const last = cards.map((x) => x.acknowledged_at).filter(Boolean).sort().at(-1);
  const [acked, setAcked] = useState<string | null>(done ? (last ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
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
      if (at) setAcked(at);
    } catch (e) {
      setAcked(null);
      onAcknowledged?.(ids, null);
      const message = e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed';
      setError(message);
      announce(`Not acknowledged: ${message}`);
    }
  };

  const Icon = c.kind === 'signal' ? Bell : FileText;
  const ledger = density === 'ledger';
  return (
    <article
      data-card={c.id}
      data-kind={c.kind}
      tabIndex={-1}
      className={cn('update-row relative touch-pan-y outline-none transition-transform duration-150', ledger ? 'py-2' : 'py-3', focused && 'ring-2 ring-ring rounded-md')}
      style={swipe.dx ? { transform: `translateX(${swipe.dx / 3}px)` } : undefined}
      {...swipe.handlers}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-meta font-medium uppercase tracking-meta text-muted-foreground">
            <Icon className="size-3.5 flex-none" aria-label={c.kind} />
            <span className="truncate">{c.producer}</span>
            <span aria-hidden>·</span>
            <time dateTime={c.received_at}>{clock(c.received_at, timezone)}</time>
          </div>
          <h4 className={cn('mt-0.5 font-serif font-semibold tracking-editorial', ledger ? 'text-body' : 'text-title')}>
            <Link href={cardHref(c.id)} className="hover:underline">{c.title}</Link>
          </h4>
          {!ledger && c.rendered_lead && <p className="lead mt-0.5 text-lead text-muted-foreground" dangerouslySetInnerHTML={{ __html: c.rendered_lead }} />}
        </div>
        <div className="flex-none pt-3">
          {acked ? (
            <span className="state-line text-meta text-muted-foreground" role="status">Acknowledged · {clock(acked, timezone)}</span>
          ) : (
            <Button size="xs" variant="outline" disabled={!online} onClick={() => void ack()}>Acknowledge</Button>
          )}
        </div>
      </div>
      {!ledger && !acked && c.first_visual && (
        // §3.1: in a fold, at most the first visual, fitted to the width, never cropped, captioned.
        <figure className="mt-2">
          <button className="block w-full cursor-zoom-in" onClick={() => setViewing(true)} aria-label={`Open ${c.first_visual.caption || 'the visual'} full-screen`}>
            {/* A fixed box, so the page does not move when the image arrives; contained, so it is never cropped. */}
            <img src={c.first_visual.src} alt={c.first_visual.caption} loading="lazy" className="block h-44 w-full rounded-sm border bg-white object-contain" />
          </button>
          {c.first_visual.caption && <figcaption className="mt-1 text-meta text-muted-foreground">{c.first_visual.caption}</figcaption>}
          {viewing && <Viewer visual={{ src: c.first_visual.src, caption: c.first_visual.caption }} onClose={() => setViewing(false)} />}
        </figure>
      )}
      {thread.earlier.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group mt-1 flex items-center gap-1 text-lead text-muted-foreground">
            {thread.earlier.length} earlier in this thread <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-0.5 text-lead">
              {thread.earlier.map((e) => (
                <li key={e.id} className="truncate">
                  <span className="text-muted-foreground">{clock(e.received_at, timezone)}</span> <Link href={cardHref(e.id)} className="hover:underline">{e.title}</Link>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {error && <p className="mt-1 text-lead text-destructive" role="alert">{error}</p>}
      {deferred.toast}
    </article>
  );
}
