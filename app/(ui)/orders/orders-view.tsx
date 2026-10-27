'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cardHref, when } from '../client';
import type { MeCard } from '../components';

export interface Order extends MeCard {
  to_producer: string;
  exec_state: 'open' | 'claimed' | 'done' | 'failed' | 'cancelled';
  claimed_by?: string;
  claim_expires_at?: string;
  claim_seq?: number;
  progress: { count: number; latest: MeCard | null };
}

const ACTIVE = ['open', 'claimed'];

/** Orders (mobile PRD): open orders with exec_state, grouped by executor; give one; cancel one. */
export function OrdersView() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [timezone, setTimezone] = useState<string | undefined>();
  const [producers, setProducers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ orders: Order[]; timezone: string }>('/api/me/orders');
    if (r.status !== 200) return setError(`could not load orders (${r.status})`);
    setOrders(r.body.orders);
    setTimezone(r.body.timezone);
  }, []);
  useEffect(() => {
    void load();
    void api<{ producers: Array<{ root: string; revoked: boolean }> }>('/api/me/producers').then((r) => {
      if (r.status === 200) setProducers(r.body.producers.filter((p) => !p.revoked).map((p) => p.root));
    });
  }, [load]);

  if (error) return <main><p className="error">{error}</p></main>;
  const active = (orders ?? []).filter((o) => ACTIVE.includes(o.exec_state) && o.state === 'open');
  const finished = (orders ?? []).filter((o) => !active.includes(o));
  // Grouped by who has it: the lease holder, else the addressee (`*` until someone claims it).
  const groups = new Map<string, Order[]>();
  for (const o of active) groups.set(o.claimed_by ?? o.to_producer, [...(groups.get(o.claimed_by ?? o.to_producer) ?? []), o]);

  return (
    <main>
      <h1>Orders</h1>
      <NewOrder producers={producers} onGiven={load} />
      {orders === null && <p className="muted">Loading…</p>}
      {orders !== null && active.length === 0 && <p className="muted">No open orders.</p>}
      {[...groups.entries()].map(([who, list]) => (
        <section key={who}>
          <h2>{who === '*' ? 'Any executor' : who} · {list.length}</h2>
          {list.map((o) => <OrderItem key={o.id} order={o} onChanged={load} timezone={timezone} />)}
        </section>
      ))}
      {finished.length > 0 && (
        <>
          <h2>This week</h2>
          {finished.map((o) => <OrderItem key={o.id} order={o} onChanged={load} timezone={timezone} />)}
        </>
      )}
    </main>
  );
}

/** The order is dictated, not parsed (mobile PRD): first line is the title, the rest the body. */
function NewOrder({ producers, onGiven }: { producers: string[]; onGiven: () => void }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState('*');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const give = async () => {
    const [title, ...rest] = text.trim().split('\n');
    setBusy(true);
    setError(null);
    const r = await api<{ message?: string }>('/api/me/orders', { method: 'POST', body: { to_producer: to, title: title!.trim(), body: rest.join('\n').trim() } });
    setBusy(false);
    if (r.status !== 201) return setError(r.body.message ?? `could not give the order (${r.status})`);
    setText('');
    onGiven();
  };
  return (
    <section className="card">
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={'What should be done?\nDetails on the next lines.'} aria-label="Order" />
      <div className="row" style={{ alignItems: 'center' }}>
        <label className="muted">
          To{' '}
          <select value={to} onChange={(e) => setTo(e.target.value)} style={{ font: 'inherit', padding: 6 }}>
            <option value="*">any executor</option>
            {producers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <button className="primary" onClick={give} disabled={busy || text.trim() === ''}>Give order</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export function ExecBadge({ order }: { order: Pick<Order, 'exec_state'> }) {
  const tone = order.exec_state === 'done' ? 'decided' : order.exec_state === 'claimed' || order.exec_state === 'open' ? 'new' : '';
  return <span className={`badge ${tone}`}>{order.exec_state}</span>;
}

/** Cancelling is the decision `dismissed` on the order (A.1), behind the same undo toast as any decision. */
export function CancelOrder({ order, onCancelled }: { order: Order | MeCard; onCancelled: (c: MeCard) => void }) {
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const cancel = () => {
    setPending(true);
    timer.current = setTimeout(async () => {
      const r = await api<MeCard>(`/api/me/cards/${encodeURIComponent(order.id)}/decision`, { method: 'POST', body: { decision: 'dismissed' } });
      setPending(false);
      if (r.status === 200 || r.status === 409) onCancelled(r.body);
    }, 4000);
  };
  return (
    <>
      <button className="danger" onClick={cancel} disabled={pending}>Cancel order</button>
      {pending && (
        <div className="toast" role="status">
          <span>Cancelling: {order.title}</span>
          <button onClick={() => { if (timer.current) clearTimeout(timer.current); setPending(false); }}>Undo</button>
        </div>
      )}
    </>
  );
}

function OrderItem({ order, onChanged, timezone }: { order: Order; onChanged: () => void; timezone?: string }) {
  const latest = order.progress.latest;
  return (
    <article className="card">
      <h3><Link href={cardHref(order.id)}>{order.title}</Link></h3>
      <div className="meta">
        <ExecBadge order={order} />
        <span>to {order.to_producer === '*' ? 'any executor' : order.to_producer}</span>
        {order.claimed_by && <span>· held by {order.claimed_by} until {when(order.claim_expires_at!, timezone)}</span>}
        <span>· {when(order.received_at, timezone)}</span>
      </div>
      {latest && (
        <p className="muted" style={{ marginBottom: 0 }}>
          {order.progress.count > 1 ? `${order.progress.count} updates · latest: ` : ''}
          <Link href={cardHref(latest.id)}>{latest.title}</Link>
          {latest.order_outcome === 'stale' && <span className="badge"> late</span>}
        </p>
      )}
      {ACTIVE.includes(order.exec_state) && order.state === 'open' && (
        <div className="row"><CancelOrder order={order} onCancelled={onChanged} /></div>
      )}
    </article>
  );
}
