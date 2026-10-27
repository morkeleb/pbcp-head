'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cardHref, when } from '../client';
import { DecisionControls, Rendered, Thumb, type MeCard } from '../components';

interface Fold {
  producer: string;
  thread: string | null;
  count: number;
  latest: MeCard;
  cards: Array<{ id: string; title: string; kind: string; received_at: string; acknowledged_at?: string }>;
}

interface Brief {
  date: string;
  timezone: string;
  seq: number;
  last_visit: { seq: number; at: string | null };
  daily: MeCard | null;
  decisions: MeCard[];
  threads: Fold[];
  snoozed: number;
  late_outcomes: MeCard[];
  lapsed_orders: MeCard[];
  new: string[];
}

export function BriefView() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef<number | null>(null);

  const load = useCallback(async () => {
    const r = await api<Brief>('/api/me/brief');
    if (r.status !== 200) return setError(`could not load the brief (${r.status})`);
    setBrief(r.body);
    seq.current ??= r.body.seq; // the first view sets what "seen" means when the owner leaves
  }, []);
  useEffect(() => void load(), [load]);

  // Leaving the brief advances the global last-visit cursor to what was on screen (mobile PRD: on close).
  useEffect(() => {
    let sent = false;
    const leave = () => {
      if (sent || seq.current === null) return;
      sent = true;
      void api('/api/me/visit', { method: 'POST', body: { seq: seq.current }, keepalive: true }).catch(() => undefined);
    };
    const hidden = () => document.visibilityState === 'hidden' && leave();
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      leave();
    };
  }, []);

  if (error) return <main><p className="error">{error}</p></main>;
  if (!brief) return <main><p className="muted">Loading…</p></main>;
  const isNew = (id: string) => brief.new.includes(id);
  const replace = (c: MeCard) => setBrief((b) => b && { ...b, decisions: b.decisions.filter((d) => d.id !== c.id) });

  return (
    <main>
      <h1>{new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${brief.date}T00:00:00Z`))}</h1>
      <p className="muted">
        {brief.new.length > 0 ? `${brief.new.length} new since ${brief.last_visit.at ? when(brief.last_visit.at, brief.timezone) : 'your first visit'}` : 'Nothing new since your last visit'}
        {brief.snoozed > 0 && ` · ${brief.snoozed} snoozed`}
      </p>

      {brief.daily && (
        <section className="card">
          <h3><Link href={cardHref(brief.daily.id)}>{brief.daily.title}</Link></h3>
          <Rendered html={brief.daily.rendered_html} />
        </section>
      )}

      <h2>Decisions · {brief.decisions.length}</h2>
      {brief.decisions.length === 0 && <p className="muted">Nothing is waiting for you.</p>}
      {brief.decisions.map((c) => <DecisionItem key={c.id} card={c} isNew={isNew(c.id)} onDecided={replace} timezone={brief.timezone} />)}

      {brief.lapsed_orders.length > 0 && (
        <>
          <h2>Orders back on the shelf</h2>
          <p className="muted">An executor took these and let the lease lapse without a result; any executor may take them again.</p>
          {brief.lapsed_orders.map((o) => <p key={o.id}><Link href={cardHref(o.id)}>{o.title}</Link> <span className="badge">claim {o.claim_seq}</span></p>)}
        </>
      )}
      {brief.late_outcomes.length > 0 && (
        <>
          <h2>Late results</h2>
          <p className="muted">These arrived after the order ended or from an earlier lease; they changed nothing.</p>
          {brief.late_outcomes.map((c) => <p key={c.id}><Link href={cardHref(c.id)}>{c.title}</Link> <span className="muted">{c.producer}</span></p>)}
        </>
      )}

      <h2>Today</h2>
      {brief.threads.length === 0 && <p className="muted">No artifacts or signals today.</p>}
      {brief.threads.map((f) => <FoldItem key={`${f.producer}:${f.latest.id}`} fold={f} isNew={f.cards.some((c) => isNew(c.id))} timezone={brief.timezone} />)}
    </main>
  );
}

function DecisionItem({ card, isNew, onDecided, timezone }: { card: MeCard; isNew: boolean; onDecided: (c: MeCard) => void; timezone: string }) {
  const [open, setOpen] = useState(false);
  const expand = () => {
    setOpen((o) => !o);
    // Showing the body is presenting the card to its owner (§4.2 seen_at); listing the title is not.
    if (!open && !card.seen_at) void api(`/api/me/cards/${encodeURIComponent(card.id)}/seen`, { method: 'POST' });
  };
  return (
    <article className="card">
      <h3><Link href={cardHref(card.id)}>{card.title}</Link></h3>
      <div className="meta">
        <span>{card.producer}</span>·<span>{when(card.received_at, timezone)}</span>
        {isNew && <span className="badge new">new</span>}
      </div>
      {card.first_visual && !open && <Thumb visual={card.first_visual} />}
      {open ? <Rendered html={card.rendered_html} /> : null}
      <button onClick={expand} style={{ marginTop: 8, minHeight: 32, padding: '2px 10px', fontSize: 14 }}>{open ? 'Hide' : 'Read'}</button>
      <DecisionControls card={card} onDecided={onDecided} />
    </article>
  );
}

function FoldItem({ fold, isNew, timezone }: { fold: Fold; isNew: boolean; timezone: string }) {
  const [acked, setAcked] = useState(fold.cards.every((c) => c.acknowledged_at));
  const ack = async () => {
    // The swipe-to-acknowledge gesture: acknowledges every card shown in the fold (§4.2 acknowledged_at).
    for (const c of fold.cards) if (!c.acknowledged_at) await api(`/api/me/cards/${encodeURIComponent(c.id)}/ack`, { method: 'POST' });
    setAcked(true);
  };
  const c = fold.latest;
  return (
    <article className="card">
      <h3><Link href={cardHref(c.id)}>{c.title}</Link></h3>
      <div className="meta">
        <span>{fold.producer}</span>
        {fold.thread && <><span>·</span><span>{fold.thread}</span></>}
        <span>·</span><span>{when(c.received_at, timezone)}</span>
        {fold.count > 1 && <span className="badge">{fold.count} in thread</span>}
        {isNew && <span className="badge new">new</span>}
      </div>
      {/* §3.1: a folded card shows at most its first visual. */}
      {c.first_visual && <Thumb visual={c.first_visual} />}
      <div className="row">
        <button onClick={ack} disabled={acked}>{acked ? 'Acknowledged' : 'Acknowledge'}</button>
      </div>
    </article>
  );
}
