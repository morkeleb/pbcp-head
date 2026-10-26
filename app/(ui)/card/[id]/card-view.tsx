'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, cardHref, when } from '../../client';
import { DecisionControls, DecisionSummary, Rendered, type MeCard } from '../../components';

interface Summary {
  id: string;
  title: string;
  kind: string;
  state: string;
  received_at: string;
  decision?: string;
}

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

  const load = async () => {
    const r = await api<Detail>(`/api/me/cards/${encodeURIComponent(idFromPath())}`);
    if (r.status !== 200) return setStatus(r.status === 404 ? 'No such card.' : `Could not load the card (${r.status}).`);
    setDetail(r.body);
    // Opening the card presents it to its owner (§4.2 seen_at).
    if (!r.body.card.seen_at) void api(`/api/me/cards/${encodeURIComponent(r.body.card.id)}/seen`, { method: 'POST' });
  };
  useEffect(() => void load(), []);

  if (status) return <main><p className="error">{status}</p></main>;
  if (!detail) return <main><p className="muted">Loading…</p></main>;
  const { card, timezone } = detail;
  const update = (c: Partial<MeCard>) => setDetail((d) => d && { ...d, card: { ...d.card, ...c } });
  const post = async (path: string, body?: unknown) => {
    const r = await api<MeCard>(`/api/me/cards/${encodeURIComponent(card.id)}/${path}`, { method: 'POST', body });
    if (r.status === 200) update(r.body);
  };

  return (
    <main>
      <div className="meta" style={{ marginTop: 8 }}>
        <span>{card.producer}</span>·<span>{card.kind}</span>·<span>{when(card.received_at, timezone)}</span>
        <span className="badge">{card.state}</span>
        {card.snoozed_until && <span className="badge">snoozed until {when(card.snoozed_until, timezone)}</span>}
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

      <DecisionSummary card={card} timezone={timezone} />
      <DecisionControls card={card} onDecided={(c) => update(c)} />

      {card.state === 'open' && card.kind !== 'decision' && (
        <div className="row">
          <button onClick={() => post('ack')} disabled={!!card.acknowledged_at}>{card.acknowledged_at ? 'Acknowledged' : 'Acknowledge'}</button>
        </div>
      )}
      {card.state === 'open' && (
        <div className="row">
          <span className="muted" style={{ alignSelf: 'center' }}>Snooze:</span>
          <button onClick={() => post('snooze', { preset: 'tonight' })}>Tonight</button>
          <button onClick={() => post('snooze', { preset: 'tomorrow' })}>Tomorrow’s brief</button>
          <button onClick={() => post('snooze', { preset: 'next-week' })}>Next week</button>
          {card.snoozed_until && <button onClick={() => post('snooze', { until: null })}>Unsnooze</button>}
        </div>
      )}

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
          <h2>Thread · {card.thread}</h2>
          {detail.thread.map((t) => (
            <p key={t.id} style={{ margin: '4px 0' }}>
              {t.id === card.id ? <strong>{t.title}</strong> : <Link href={cardHref(t.id)}>{t.title}</Link>}{' '}
              <span className="muted">{when(t.received_at, timezone)}</span> {t.decision && <span className="badge decided">{t.decision}</span>}
            </p>
          ))}
        </>
      )}
    </main>
  );
}
