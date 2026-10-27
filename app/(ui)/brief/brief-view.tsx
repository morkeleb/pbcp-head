'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cardHref, OfflineError, useFresh, useOnline, when } from '../client';
import { announce, AsOf, CardBody, DecisionControls, Lead, NOT_SENT, Rendered, swipeChoice, Thumb, useDeferred, useSwipe, type DecisionHandle, type MeCard } from '../components';

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
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  // Cards decided or acknowledged on this page: no longer "new", whatever the brief said when it loaded.
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const seq = useRef<number | null>(null);

  const load = useCallback(async (network = false) => {
    const r = await api<Brief>('/api/me/brief', { network });
    if (r.status !== 200) return setError(r.status === 0 || r.status === 503 ? 'You’re offline, and this device has no copy of the brief yet.' : `could not load the brief (${r.status})`);
    setBrief(r.body);
    setCachedAt(r.cachedAt ?? null);
    seq.current ??= r.body.seq; // the first view sets what "seen" means when the owner leaves
  }, []);
  useEffect(() => void load(), [load]);
  // Shown from the cache first; the network's answer replaces it when it comes.
  const fresh = useCallback((b: Brief) => {
    setBrief(b);
    setCachedAt(null);
  }, []);
  const stale = useCallback(() => void load(true), [load]);
  useFresh('/api/me/brief', fresh, stale);

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
  const isNew = (id: string) => brief.new.includes(id) && !handled.has(id);
  const mark = (ids: string[], done: boolean) =>
    setHandled((h) => {
      const next = new Set(h);
      for (const id of ids) done ? next.add(id) : next.delete(id);
      return next;
    });
  // Deciding changes the card in place (and back, if the head refuses).
  const replace = (c: MeCard) => {
    setBrief((b) => b && { ...b, decisions: b.decisions.map((d) => (d.id === c.id ? c : d)) });
    mark([c.id], c.state !== 'open');
  };
  const todays = brief.daily?.id === `head:daily:${brief.date}` ? brief.daily : null;

  return (
    <main>
      <h1>{new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${brief.date}T00:00:00Z`))}</h1>
      <p className="muted">
        {brief.new.length > 0 ? `${brief.new.length} new since ${brief.last_visit.at ? when(brief.last_visit.at, brief.timezone) : 'your first visit'}` : 'Nothing new since your last visit'}
        {brief.snoozed > 0 && ` · ${brief.snoozed} snoozed`} <AsOf at={cachedAt} timezone={brief.timezone} />
      </p>

      {todays ? (
        <section className="card daily">
          <h3><Link href={cardHref(todays.id)}>{todays.title}</Link></h3>
          <Rendered html={todays.rendered_html} />
        </section>
      ) : (
        <SoFarToday brief={brief} />
      )}

      <h2>Decisions · {brief.decisions.length}</h2>
      {brief.decisions.length === 0 && <p className="muted">Nothing is waiting for you.</p>}
      {brief.decisions.map((c) => <DecisionItem key={c.id} card={c} isNew={isNew(c.id)} onChange={replace} timezone={brief.timezone} />)}

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
          {brief.late_outcomes.map((c) => (
            <p key={c.id}>
              <Link href={cardHref(c.id)}>{c.title}</Link> <span className="badge">claim {c['orders.claim_seq']}{c['orders.result'] ? ` · ${c['orders.result']}` : ''}</span> <span className="muted">{c.producer}</span>
            </p>
          ))}
        </>
      )}

      <h2>Today</h2>
      {brief.threads.length === 0 && <p className="muted">No artifacts or signals today.</p>}
      {brief.threads.map((f) => (
        <FoldItem key={`${f.producer}:${f.latest.id}`} fold={f} isNew={f.cards.some((c) => isNew(c.id))} timezone={brief.timezone} onAcked={(ids) => mark(ids, true)} onFailed={(ids) => mark(ids, false)} />
      ))}
    </main>
  );
}

/**
 * Before the nightly card exists for today (the cron has not run yet), the same fold, live from this brief:
 * what is waiting, then today's threads, each a linked title and its lead (lib/brief/fold.ts, as elements).
 */
function SoFarToday({ brief }: { brief: Brief }) {
  const open = brief.decisions.filter((c) => c.state === 'open');
  const cards = brief.threads.reduce((n, f) => n + f.count, 0);
  const producers = new Set(brief.threads.map((f) => f.producer)).size;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  // "title — lead", linked (§8), the lead as the head rendered it.
  const Line = ({ card, count = 1 }: { card: MeCard; count?: number }) => (
    <li>
      <Link href={cardHref(card.id)}>{card.title}</Link>
      {count > 1 && <span className="muted"> ({count} in thread)</span>}
      {card.rendered_lead && <> — <span dangerouslySetInnerHTML={{ __html: card.rendered_lead }} /></>}
    </li>
  );
  return (
    <section className="card daily" aria-label="So far today">
      <h3>So far today</h3>
      {open.length === 0 ? <p>Nothing is waiting for you.</p> : <ul>{open.map((c) => <Line key={c.id} card={c} />)}</ul>}
      {brief.threads.length > 0 && <ul>{brief.threads.map((f) => <Line key={f.latest.id} card={f.latest} count={f.count} />)}</ul>}
      <p className="muted">{plural(open.length, 'open decision')} · {plural(cards, 'card')} today from {plural(producers, 'producer')}</p>
    </section>
  );
}

function DecisionItem({ card, isNew, onChange, timezone }: { card: MeCard; isNew: boolean; onChange: (c: MeCard) => void; timezone: string }) {
  const decided = card.state === 'decided';
  const online = useOnline();
  const controls = useRef<DecisionHandle | null>(null);
  const deferred = useDeferred();
  // Swipe right: the default; swipe left: dismiss. Committed after the undo window, not at once.
  const swipe = useSwipe((direction) => {
    const choice = decided || !online || deferred.pending ? null : swipeChoice(card, direction);
    if (choice) deferred.schedule(`${choice.label}: ${card.title}`, () => controls.current?.decide({ decision: choice.decision }));
  });
  return (
    <article className={`card swipeable${decided ? ' done' : ''}`} {...swipe.handlers} style={swipe.dx ? { transform: `translateX(${swipe.dx / 3}px)` } : undefined}>
      <h3><Link href={cardHref(card.id)}>{card.title}</Link></h3>
      <div className="meta">
        <span>{card.producer}</span>·<span>{when(card.received_at, timezone)}</span>
        {isNew && !decided && <span className="badge new">new</span>}
      </div>
      {decided ? <Lead card={card} /> : <CardBody card={card} />}
      <DecisionControls card={card} onChange={onChange} showDecided handle={controls} />
      {deferred.toast}
    </article>
  );
}

function FoldItem({ fold, isNew, timezone, onAcked, onFailed }: { fold: Fold; isNew: boolean; timezone: string; onAcked: (ids: string[]) => void; onFailed: (ids: string[]) => void }) {
  const c = fold.latest;
  const ids = fold.cards.map((x) => x.id);
  const last = fold.cards.map((x) => x.acknowledged_at).filter(Boolean).sort().at(-1);
  const [acked, setAcked] = useState<string | null>(fold.cards.every((x) => x.acknowledged_at) ? (last ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();
  const time = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  // A swipe either way acknowledges, after the undo window; the button does at once.
  const deferred = useDeferred();
  const swipe = useSwipe(() => {
    if (!acked && online && !deferred.pending) deferred.schedule(`Acknowledge: ${c.title}`, () => void ack());
  });
  // Acknowledges every card shown in the fold (§4.2 acknowledged_at): at once on screen, then on the head.
  const ack = async () => {
    setError(null);
    setAcked(new Date().toISOString());
    onAcked(ids);
    announce(`Acknowledged: ${c.title}`);
    try {
      let at: string | undefined;
      for (const x of fold.cards) {
        if (x.acknowledged_at) continue;
        const r = await api<{ acknowledged_at?: string; message?: string }>(`/api/me/cards/${encodeURIComponent(x.id)}/ack`, { method: 'POST' });
        if (r.status !== 200) throw new Error(r.body?.message ?? `the head answered ${r.status}`);
        at = r.body.acknowledged_at ?? at;
      }
      if (at) setAcked(at);
    } catch (e) {
      setAcked(null);
      onFailed(ids);
      const message = e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed';
      setError(message);
      announce(`Not acknowledged: ${message}`);
    }
  };
  return (
    <article className={`card swipeable${acked ? ' done' : ''}`} {...swipe.handlers} style={swipe.dx ? { transform: `translateX(${swipe.dx / 3}px)` } : undefined}>
      <h3><Link href={cardHref(c.id)}>{c.title}</Link></h3>
      {!acked && (
        <div className="meta">
          <span>{fold.producer}</span>
          <span>·</span><span>{when(c.received_at, timezone)}</span>
          {fold.count > 1 && <span className="badge">{fold.count} in thread</span>}
          {isNew && <span className="badge new">new</span>}
        </div>
      )}
      <Lead card={c} />
      {/* §3.1: a folded card shows at most its first visual. */}
      {!acked && c.first_visual && <Thumb visual={c.first_visual} />}
      {acked ? (
        <p className="decided-line">Acknowledged {time(acked)}</p>
      ) : (
        <div className="row">
          <button onClick={ack} disabled={!online}>Acknowledge</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {deferred.toast}
    </article>
  );
}
