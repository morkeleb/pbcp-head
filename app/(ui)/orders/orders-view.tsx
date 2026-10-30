'use client';

// Orders (Appendix A; mobile PRD), built from the brief's parts: each order as a block styled like a DecisionCard, with
// its exec_state and where it went in a small table and its lease as one line ("claimed by hermes at 09:02, lease until
// 09:12, renewed twice", "waiting for an executor", "lease lapsed at 09:12"); under it what came back (A.3): the outcome
// as the brief's UpdateRow, then the progress notes newest first, one line each, the latest shown and the rest behind
// "N earlier". Grouped open, then done. A new order is given from the form at the top.

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { clock } from '../brief/DecisionCard';
import { UpdateRow } from '../brief/UpdateRow';
import { PageRow, useChromeCards } from '../chrome';
import { api, cardHref, OfflineError, OFFLINE_REASON, useLiveChanges, useOnline, when } from '../client';
import { NOT_SENT, useDeferred, useLocale, type MeCard } from '../components';

export interface Order extends MeCard {
  to_producer: string;
  exec_state: 'open' | 'claimed' | 'done' | 'failed' | 'cancelled';
  claimed_by?: string;
  claim_expires_at?: string;
  claim_seq?: number;
  /** The lease as the owner sees it (head-private, A.2). */
  lease?: { claimed_at: string | null; renewals: number; lapsed_at: string | null };
  progress: {
    count: number;
    latest: MeCard | null;
    /** Every progress card, newest first (A.3). */
    notes?: Array<{ id: string; title: string; received_at: string }>;
    /** The latest outcome card, in full. */
    outcome?: MeCard | null;
  };
}

/**
 * The lease as one line (A.2): who holds it, since when, until when and how often it was renewed; or that the order
 * waits for an executor; or when the last lease lapsed with no outcome. Nothing once the order has ended.
 */
export function leaseLine(o: Pick<Order, 'exec_state' | 'claimed_by' | 'claim_expires_at' | 'lease'>, timezone: string, locale?: string): string | null {
  const t = (iso: string) => {
    const day = (x: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(x));
    return day(iso) === day(new Date().toISOString()) ? clock(iso, timezone, locale) : when(iso, timezone, locale);
  };
  if (o.exec_state === 'claimed' && o.claimed_by) {
    const n = o.lease?.renewals ?? 0;
    return [
      `claimed by ${o.claimed_by}${o.lease?.claimed_at ? ` at ${t(o.lease.claimed_at)}` : ''}`,
      ...(o.claim_expires_at ? [`lease until ${t(o.claim_expires_at)}`] : []),
      ...(n > 0 ? [`renewed ${n} ${n === 1 ? 'time' : 'times'}`] : []),
    ].join(', ');
  }
  if (o.exec_state === 'open') return o.lease?.lapsed_at ? `lease lapsed at ${t(o.lease.lapsed_at)}` : 'waiting for an executor';
  return null;
}

const ACTIVE = ['open', 'claimed'];
const isActive = (o: Pick<Order, 'exec_state' | 'state'>) => ACTIVE.includes(o.exec_state) && o.state === 'open';

export function OrdersView() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [timezone, setTimezone] = useState<string | undefined>();
  const [producers, setProducers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchOrders = useCallback(async (network: boolean) => {
    const r = await api<{ orders: Order[]; timezone: string }>('/api/me/orders', { network });
    if (r.status !== 200) return setError(`Could not load orders (${r.status}).`);
    setOrders(r.body.orders);
    setTimezone(r.body.timezone);
  }, []);
  const load = useCallback(() => fetchOrders(false), [fetchOrders]);
  useEffect(() => {
    void load();
    void api<{ producers: Array<{ root: string; revoked: boolean }> }>('/api/me/producers').then((r) => {
      if (r.status === 200) setProducers(r.body.producers.filter((p) => !p.revoked).map((p) => p.root));
    });
  }, [load]);
  // Live: an order claimed, progressing or done shows so without a reload; while one is open or claimed, the page looks
  // every ten seconds, since an executor usually picks an order up soon after it is given.
  const working = (orders ?? []).some(isActive);
  const reload = useCallback(() => fetchOrders(true), [fetchOrders]);
  useLiveChanges(reload, working ? 10_000 : 60_000);
  useChromeCards([...(orders ?? []), ...(orders ?? []).flatMap((o) => (o.progress.latest ? [o.progress.latest] : []))]);

  const open = (orders ?? []).filter(isActive);
  const done = (orders ?? []).filter((o) => !isActive(o));
  const tz = timezone ?? 'UTC';
  // What came back: the outcome first, as the brief shows an update; then the progress notes.
  const outcome = (o: Order) => {
    const card = o.progress.outcome ?? (o.progress.notes ? null : o.progress.latest);
    return card && <UpdateRow thread={{ latest: card, earlier: [] }} timezone={tz} />;
  };
  const back = (o: Order) =>
    (o.progress.outcome || o.progress.notes?.length || (!o.progress.notes && o.progress.latest)) && (
      <div className="ml-4 border-l pl-3" data-order-progress={o.id}>
        {outcome(o)}
        <ProgressNotes notes={o.progress.notes ?? []} timezone={tz} />
      </div>
    );

  return (
    <>
      <PageRow title="Orders" />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-4 min-[900px]:px-6">
        {error && <p className="text-lead text-destructive" role="alert">{error}</p>}
        <NewOrder producers={producers} onGiven={load} />
        {orders === null && !error && <p className="py-3 text-lead text-muted-foreground">Loading…</p>}

        <Group title="Open" count={orders ? open.length : undefined}>
          {orders !== null && open.length === 0 && <p className="text-lead text-muted-foreground">No open orders.</p>}
          <div className="flex flex-col gap-3">
            {open.map((o) => (
              <div key={o.id}>
                <OrderBlock order={o} timezone={tz} onChanged={load} />
                {back(o)}
              </div>
            ))}
          </div>
        </Group>

        {done.length > 0 && (
          <Group title="Done" count={done.length}>
            {/* What came back from each: the outcome as the brief shows an update; an order with none, as its block. */}
            <div className="divide-y border-y">
              {done.map((o) => (
                <div key={o.id} className="py-3">
                  <OrderBlock order={o} timezone={tz} onChanged={load} />
                  {back(o)}
                </div>
              ))}
            </div>
          </Group>
        )}
      </main>
    </>
  );
}

/** The progress notes, newest first, one line each (time · note): the latest, then the rest behind "N earlier". */
function ProgressNotes({ notes, timezone }: { notes: Array<{ id: string; title: string; received_at: string }>; timezone: string }) {
  const locale = useLocale();
  if (notes.length === 0) return null;
  const row = (n: (typeof notes)[number]) => (
    <li key={n.id} className="flex min-w-0 items-baseline gap-2" data-progress-note={n.id}>
      <time className="flex-none text-meta tabular-nums text-muted-foreground" dateTime={n.received_at}>{clock(n.received_at, timezone, locale)}</time>
      <Link href={cardHref(n.id)} className="min-w-0 truncate text-lead hover:underline">{n.title}</Link>
    </li>
  );
  const [latest, ...earlier] = notes;
  return (
    <div className="py-2" data-progress>
      <ol className="space-y-1">{row(latest!)}</ol>
      {earlier.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group mt-1 flex items-center gap-1 text-lead text-muted-foreground">
            {earlier.length} earlier <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-1 space-y-1">{earlier.map(row)}</ol>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function Group({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="pt-6">
      <h3 className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">
        {title}
        {count !== undefined && <span className="font-normal"> ({count})</span>}
      </h3>
      {children}
    </section>
  );
}

/** The order is dictated, not parsed (mobile PRD): first line is the title, the rest the body. */
function NewOrder({ producers, onGiven }: { producers: string[]; onGiven: () => void }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState('*');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();
  const give = async () => {
    const [title, ...rest] = text.trim().split('\n');
    setBusy(true);
    setError(null);
    let r: { status: number; body: { message?: string } };
    try {
      r = await api<{ message?: string }>('/api/me/orders', { method: 'POST', body: { to_producer: to, title: title!.trim(), body: rest.join('\n').trim() } });
    } catch (e) {
      setBusy(false);
      if (!(e instanceof OfflineError)) throw e;
      return setError(NOT_SENT);
    }
    setBusy(false);
    if (r.status !== 201) return setError(r.body.message ?? `Could not give the order (${r.status}).`);
    setText('');
    onGiven();
  };
  const field = 'w-full rounded-md border border-input bg-background p-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <section className="rounded-lg border bg-card p-4 text-card-foreground max-[899px]:p-3" aria-label="Give an order">
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={'What should be done?\nDetails on the next lines.'} aria-label="Order" className={field} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-lead text-muted-foreground">
          To
          <select value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-body text-foreground">
            <option value="*">any executor</option>
            {producers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <Button size="sm" className="ml-auto" onClick={give} disabled={busy || text.trim() === '' || !online}>Give order</Button>
      </div>
      {!online && <p className="mt-2 text-lead text-muted-foreground" role="status">{OFFLINE_REASON}</p>}
      {error && <p className="mt-2 text-lead text-destructive" role="alert">{error}</p>}
    </section>
  );
}

/**
 * An order as the brief styles a decision: producer line, title in the serif, then a small table of where it stands
 * (exec_state, who holds it, the lease) and, while it is open or claimed, Cancel (the decision `dismissed`, A.1) behind
 * the same undo as a swipe. Used here and on the card page.
 */
export function OrderBlock({ order, timezone, onChanged }: { order: MeCard; timezone: string; onChanged: (c?: MeCard) => void }) {
  const online = useOnline();
  const locale = useLocale();
  const deferred = useDeferred();
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setError(null);
    try {
      const r = await api<MeCard & { message?: string }>(`/api/me/cards/${encodeURIComponent(order.id)}/decision`, { method: 'POST', body: { decision: 'dismissed' } });
      if (r.status === 200 || r.status === 409) onChanged(r.body);
      else setError(r.body?.message ?? `the head answered ${r.status}`);
    } catch (e) {
      setError(e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed');
    }
  };
  const to = order.to_producer === '*' ? 'any executor' : order.to_producer;
  const rows: Array<[string, React.ReactNode]> = [
    ['State', <span key="s" data-exec-state>{order.exec_state}</span>],
    ['To', to],
  ];
  const lease = leaseLine(order as Order, timezone, locale);
  return (
    <article data-card={order.id} data-kind="order" className={cn('rounded-lg border bg-card p-4 text-card-foreground max-[899px]:p-3', !isActive(order as Order) && 'opacity-72')}>
      <div className="flex items-center gap-2 whitespace-nowrap text-meta font-medium uppercase tracking-meta text-muted-foreground">
        <span>Order</span>
        <span aria-hidden>·</span>
        <time dateTime={order.received_at}>{clock(order.received_at, timezone, locale)}</time>
      </div>
      <h3 className="font-serif text-title font-semibold tracking-editorial">
        <Link href={cardHref(order.id)} className="hover:underline">{order.title}</Link>
      </h3>
      <table className="mt-2 w-full text-lead" data-order-table>
        <tbody className="divide-y">
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" className="w-24 py-1 pr-3 text-left align-top font-normal text-muted-foreground">{k}</th>
              <td className="py-1 align-top">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lease && <p className="mt-2 text-lead text-muted-foreground" data-lease-line>{lease}</p>}
      {isActive(order as Order) && (
        <div className="mt-3">
          <Button size="sm" variant="outline" className="text-destructive" disabled={!online || deferred.pending}
            onClick={() => deferred.schedule(`Cancelling: ${order.title}`, () => void cancel())}>
            Cancel order
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-lead text-destructive" role="alert">{error}</p>}
      {deferred.toast}
    </article>
  );
}
