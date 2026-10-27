'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, cardHref, OfflineError, useFresh, useOnline, when } from '../../client';
import { AsOf, DecisionControls, DecisionSummary, NOT_SENT, OfflineNote, Rendered, type MeCard } from '../../components';
import { CancelOrder, ExecBadge } from '../../orders/orders-view';

interface Summary {
  id: string;
  title: string;
  kind: string;
  producer: string;
  state: string;
  received_at: string;
  decision?: string;
  exec_state?: string;
  order_outcome?: 'applied' | 'stale';
}

/** Progress in an order's thread is folded: the order, the latest few updates, the rest behind a disclosure (§8). */
const SHOWN = 3;

interface Detail {
  timezone: string;
  card: MeCard;
  predecessors: MeCard[];
  successors: Summary[];
  references: Array<{ id: string; card: Summary | null }>;
  thread: Summary[];
}

/** The id from the raw path, decoded once, so an id with %XX in it survives (§5). */
const idFromPath = () => decodeURIComponent(location.pathname.split('/')[2] ?? '');

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function CardView() {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [notSent, setNotSent] = useState(false);
  const online = useOnline();
  const [path] = useState(() => (typeof location === 'undefined' ? null : `/api/me/cards/${encodeURIComponent(idFromPath())}`));

  const show = useCallback((d: Detail, at: string | null) => {
    setDetail(d);
    setCachedAt(at);
    // Opening the card presents it to its owner (§4.2 seen_at). Offline it is not sent, and not kept for later.
    if (!d.card.seen_at) api(`/api/me/cards/${encodeURIComponent(d.card.id)}/seen`, { method: 'POST' }).catch(() => undefined);
  }, []);
  const load = useCallback(async (network = false) => {
    const r = await api<Detail>(path!, { network });
    if (r.status !== 200) return setStatus(r.status === 404 ? 'No such card.' : r.status === 0 || r.status === 503 ? 'You’re offline, and this device has no copy of this card yet.' : `Could not load the card (${r.status}).`);
    show(r.body, r.cachedAt ?? null);
  }, [path, show]);
  useEffect(() => void load(), [load]);
  const fresh = useCallback((d: Detail) => show(d, null), [show]);
  const stale = useCallback(() => void load(true), [load]);
  useFresh(path, fresh, stale);

  if (status) return <main><p className="error">{status}</p></main>;
  if (!detail) return <main><p className="muted">Loading…</p></main>;
  const { card, timezone } = detail;
  const update = (c: Partial<MeCard>) => setDetail((d) => d && { ...d, card: { ...d.card, ...c } });
  const post = async (action: string, body?: unknown) => {
    setNotSent(false);
    try {
      const r = await api<MeCard>(`/api/me/cards/${encodeURIComponent(card.id)}/${action}`, { method: 'POST', body });
      if (r.status === 200) update(r.body);
    } catch (e) {
      if (!(e instanceof OfflineError)) throw e;
      setNotSent(true);
    }
  };

  return (
    <main>
      <div className="meta" style={{ marginTop: 8 }}>
        <span>{card.producer}</span>·<span>{card.kind}</span>·<span>{when(card.received_at, timezone)}</span>
        <span className="badge">{card.state}</span>
        {card.snoozed_until && <span className="badge">snoozed until {when(card.snoozed_until, timezone)}</span>}
        <AsOf at={cachedAt} timezone={timezone} />
      </div>
      <h1>{card.title}</h1>
      {card.source && (
        // source.label is the producer's words, not a statement about where the link goes (§12).
        <p className="muted">
          <a href={card.source.url} target="_blank" rel="noopener noreferrer nofollow">{card.source.label || 'Source'}</a> ({host(card.source.url)})
        </p>
      )}
      <section className="card">
        <Rendered html={card.rendered_html} />
      </section>

      {card.kind === 'order' && (
        <section className="card">
          <div className="meta">
            <ExecBadge order={{ exec_state: card.exec_state! }} />
            <span>to {card.to_producer === '*' ? 'any executor' : card.to_producer}</span>
            {card.claimed_by && <span>· held by {card.claimed_by} until {when(card.claim_expires_at!, timezone)} (claim {card.claim_seq})</span>}
          </div>
          {card.state === 'open' && (card.exec_state === 'open' || card.exec_state === 'claimed') && (
            <div className="row"><CancelOrder order={card} onCancelled={(c) => update(c)} /></div>
          )}
        </section>
      )}
      {card.order_outcome === 'stale' && <p className="muted">This result came late or from an earlier lease; it did not change the order.</p>}

      <DecisionSummary card={card} timezone={timezone} />
      <DecisionControls card={card} onDecided={(c) => update(c)} />

      {card.state === 'open' && card.kind !== 'decision' && card.kind !== 'order' && (
        <div className="row">
          <button onClick={() => post('ack')} disabled={!!card.acknowledged_at || !online}>{card.acknowledged_at ? 'Acknowledged' : 'Acknowledge'}</button>
        </div>
      )}
      {card.state === 'open' && card.kind !== 'order' && (
        <div className="row">
          <span className="muted" style={{ alignSelf: 'center' }}>Snooze:</span>
          <button disabled={!online} onClick={() => post('snooze', { preset: 'tonight' })}>Tonight</button>
          <button disabled={!online} onClick={() => post('snooze', { preset: 'tomorrow' })}>Tomorrow’s brief</button>
          <button disabled={!online} onClick={() => post('snooze', { preset: 'next-week' })}>Next week</button>
          {card.snoozed_until && <button disabled={!online} onClick={() => post('unsnooze')}>Unsnooze</button>}
        </div>
      )}
      {card.state === 'open' && card.kind !== 'decision' && <OfflineNote />}
      {notSent && <p className="error">{NOT_SENT}</p>}

      {detail.successors.length > 0 && (
        <>
          <h2>Superseded by</h2>
          {detail.successors.map((s) => <p key={s.id}><Link href={cardHref(s.id)}>{s.title}</Link> <span className="badge">{s.state}</span></p>)}
        </>
      )}
      {detail.predecessors.length > 0 && (
        <>
          <h2>Earlier versions</h2>
          {detail.predecessors.map((p) => (
            <details key={p.id} className="card">
              <summary>{p.title} <span className="badge">{p.decision ?? p.state}</span></summary>
              <Rendered html={p.rendered_html} />
              <DecisionSummary card={p} timezone={timezone} />
            </details>
          ))}
        </>
      )}
      {detail.references.length > 0 && (
        <>
          <h2>References</h2>
          {detail.references.map((r) => (
            <p key={r.id}>{r.card ? <Link href={cardHref(r.id)}>{r.card.title}</Link> : <span className="muted">{r.id} (not on this head)</span>}</p>
          ))}
        </>
      )}
      {detail.thread.length > 1 && (
        <>
          <h2>{detail.thread[0]!.kind === 'order' ? 'Order and progress' : `Thread · ${card.thread}`}</h2>
          {(() => {
            const row = (t: Summary) => (
              <p key={t.id} style={{ margin: '4px 0' }}>
                {t.id === card.id ? <strong>{t.title}</strong> : <Link href={cardHref(t.id)}>{t.title}</Link>}{' '}
                <span className="muted">{t.producer} · {when(t.received_at, timezone)}</span>{' '}
                {t.exec_state && <span className="badge">{t.exec_state}</span>}
                {t.decision && <span className="badge decided">{t.decision}</span>}
                {t.order_outcome === 'stale' && <span className="badge">late</span>}
              </p>
            );
            const [head, ...rest] = detail.thread;
            if (head!.kind !== 'order' || rest.length <= SHOWN) return detail.thread.map(row);
            return (
              <>
                {row(head!)}
                <details>
                  <summary className="muted">{rest.length - SHOWN} earlier updates</summary>
                  {rest.slice(0, -SHOWN).map(row)}
                </details>
                {rest.slice(-SHOWN).map(row)}
              </>
            );
          })()}
        </>
      )}
    </main>
  );
}
