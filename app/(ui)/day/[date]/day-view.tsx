'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, cardHref } from '../../client';
import type { MeCard } from '../../components';

interface Page {
  cards: MeCard[];
  next: number | null;
  timezone: string;
}

const shift = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Any date: every card received that day with its decision, in order — the decision log as a timeline. */
export function DayView({ date }: { date: string }) {
  const router = useRouter();
  const [cards, setCards] = useState<MeCard[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [tz, setTz] = useState<string | undefined>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const fetchPage = async (after: number | null) => {
    const r = await api<Page>(`/api/me/cards?date=${date}&limit=100${after ? `&after=${after}` : ''}`);
    if (r.status !== 200) return setState('error');
    setCards((cs) => (after ? [...cs, ...r.body.cards] : r.body.cards));
    setNext(r.body.next);
    setTz(r.body.timezone);
    setState('ready');
  };
  useEffect(() => {
    setState('loading');
    void fetchPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const time = (iso: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  return (
    <main>
      <div className="row" style={{ alignItems: 'center' }}>
        <button onClick={() => router.push(`/day/${shift(date, -1)}`)} aria-label="Previous day">‹</button>
        <input type="date" value={date} onChange={(e) => e.target.value && router.push(`/day/${e.target.value}`)} style={{ font: 'inherit', padding: 6 }} />
        <button onClick={() => router.push(`/day/${shift(date, 1)}`)} aria-label="Next day">›</button>
      </div>
      {state === 'error' && <p className="error">Could not load this day.</p>}
      {state === 'loading' && <p className="muted">Loading…</p>}
      {state === 'ready' && cards.length === 0 && <p className="muted">Nothing arrived on this day.</p>}
      {cards.map((c) => (
        <article key={c.id} className="card">
          <div className="meta">
            <span>{time(c.received_at)}</span>·<span>{c.producer}</span>·<span>{c.kind}</span>
            {c.decision ? <span className="badge decided">{c.decision}</span> : c.state !== 'open' ? <span className="badge">{c.state}</span> : c.kind === 'decision' ? <span className="badge new">open</span> : null}
          </div>
          <h3><Link href={cardHref(c.id)}>{c.title}</Link></h3>
          {c.comment && <p className="muted">“{c.comment}”</p>}
        </article>
      ))}
      {next !== null && <button onClick={() => fetchPage(next)}>Load more</button>}
    </main>
  );
}
