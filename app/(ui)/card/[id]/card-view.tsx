'use client';

// One card, built from the brief's parts: the card as the brief shows it (a DecisionCard, an UpdateRow for an artifact
// or signal, the order block for an order) with its body fully open, at the content width; then its thread as the brief
// shows threads (time · title, the card itself in bold); then the decision log entries for it (§4.4) as a small table.
// Supersession and references are lists in the same style: a superseded card stays reachable from its successor (§8).

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { clock, DecisionCard } from '../../brief/DecisionCard';
import { UpdateRow } from '../../brief/UpdateRow';
import { PageRow, useChromeCards } from '../../chrome';
import { api, cardHref, useFresh, when } from '../../client';
import { decisionLabel, Rendered, type MeCard } from '../../components';
import { OrderBlock } from '../../orders/orders-view';

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

interface LogEntry {
  decision: string;
  decided_at: string;
  edited_proposal?: string;
  comment?: string;
  delegated_to?: string;
  by: string;
}

interface Detail {
  timezone: string;
  card: MeCard;
  predecessors: MeCard[];
  successors: Summary[];
  references: Array<{ id: string; card: Summary | null }>;
  thread: Summary[];
  decisions: LogEntry[];
}

/** Progress in an order's thread is folded: the order, the latest few updates, the rest behind a disclosure (§8). */
const SHOWN = 3;

const KIND: Record<string, string> = { decision: 'Decision', artifact: 'Update', signal: 'Signal', order: 'Order' };

/** The id from the raw path, decoded once, so an id with %XX in it survives (§5). */
const idFromPath = () => decodeURIComponent(location.pathname.split('/')[2] ?? '');

export function CardView() {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
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
  useChromeCards(detail ? [detail.card] : [], { at: cachedAt, timezone: detail?.timezone });

  const title = detail ? (KIND[detail.card.kind] ?? 'Card') : 'Card';
  if (status || !detail) {
    return (
      <>
        <PageRow title={title} />
        <main className="mx-auto max-w-2xl px-4 pt-4 min-[900px]:px-6">
          <p className={status ? 'text-lead text-destructive' : 'text-lead text-muted-foreground'}>{status ?? 'Loading…'}</p>
        </main>
      </>
    );
  }

  const { card, timezone } = detail;
  const update = (c: MeCard) => setDetail((d) => d && { ...d, card: { ...d.card, ...c } });
  const reload = () => void load(true);

  return (
    <>
      <PageRow title={title} />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-4 min-[900px]:px-6" data-card-page>
        {card.kind === 'decision' ? (
          <DecisionCard card={card} timezone={timezone} density="comfortable" onChange={update} expanded />
        ) : card.kind === 'order' ? (
          <OrderBlock order={card} timezone={timezone} onChanged={(c) => (c ? update(c) : reload())} />
        ) : (
          <div className="border-y">
            <UpdateRow
              thread={{ latest: card, earlier: [] }}
              timezone={timezone}
              density="comfortable"
              expanded
              onAcknowledged={(_, at) => update({ ...card, ...(at ? { acknowledged_at: at } : { acknowledged_at: undefined }) })}
            />
          </div>
        )}
        {card.kind === 'order' && <Rendered className="mt-3 text-body" html={card.rendered_html} />}
        {card.order_outcome === 'stale' && <p className="mt-2 text-lead text-muted-foreground">This result came late or from an earlier lease; it did not change the order.</p>}
        {card.snoozed_until && card.snoozed_until > new Date().toISOString() && (
          <p className="mt-2 text-lead text-muted-foreground">Snoozed until {when(card.snoozed_until, timezone)}.</p>
        )}

        {detail.successors.length > 0 && (
          <Group title="Superseded by">
            <Rows items={detail.successors.map((s) => ({ key: s.id, at: s.received_at, title: s.title, href: cardHref(s.id), note: s.state }))} timezone={timezone} />
          </Group>
        )}
        {detail.predecessors.length > 0 && (
          <Group title="Earlier versions">
            <Rows items={detail.predecessors.map((p) => ({ key: p.id, at: p.received_at, title: p.title, href: cardHref(p.id), note: p.decision ? decisionLabel(p) : p.state }))} timezone={timezone} />
          </Group>
        )}
        {detail.thread.length > 1 && <Thread detail={detail} />}
        {detail.references.length > 0 && (
          <Group title="References">
            <ul className="space-y-0.5 text-lead">
              {detail.references.map((r) => (
                <li key={r.id} className="truncate">
                  {r.card ? <Link href={cardHref(r.id)} className="hover:underline">{r.card.title}</Link> : <span className="text-muted-foreground">{r.id} (not on this head)</span>}
                </li>
              ))}
            </ul>
          </Group>
        )}
        {detail.decisions.length > 0 && <DecisionLog entries={detail.decisions} timezone={timezone} />}
      </main>
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-6">
      <h3 className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** Rows as the brief lists a thread's earlier cards: the time, muted, then the title linked; the current card in bold. */
function Rows({ items, timezone }: { items: Array<{ key: string; at: string; title: string; href?: string; note?: string }>; timezone: string }) {
  return (
    <ul className="space-y-0.5 text-lead">
      {items.map((i) => (
        <li key={i.key} className="truncate">
          <span className="text-muted-foreground tabular-nums">{clock(i.at, timezone)}</span>{' '}
          {i.href ? <Link href={i.href} className="hover:underline">{i.title}</Link> : <strong className="font-semibold">{i.title}</strong>}
          {i.note && <span className="text-muted-foreground"> · {i.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function Thread({ detail }: { detail: Detail }) {
  const { card, timezone, thread } = detail;
  const item = (t: Summary) => ({
    key: t.id,
    at: t.received_at,
    title: t.title,
    href: t.id === card.id ? undefined : cardHref(t.id),
    note: [t.exec_state, t.decision, t.order_outcome === 'stale' ? 'late' : undefined].filter(Boolean).join(' · ') || undefined,
  });
  const [first, ...rest] = thread;
  const isOrder = first!.kind === 'order';
  const title = isOrder ? 'Order and progress' : `Thread · ${card.thread ?? ''}`;
  if (!isOrder || rest.length <= SHOWN) return <Group title={title}><Rows items={thread.map(item)} timezone={timezone} /></Group>;
  return (
    <Group title={title}>
      <Rows items={[item(first!)]} timezone={timezone} />
      <Collapsible>
        <CollapsibleTrigger className="group mt-1 flex items-center gap-1 text-lead text-muted-foreground">
          {rest.length - SHOWN} earlier updates <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Rows items={rest.slice(0, -SHOWN).map(item)} timezone={timezone} />
        </CollapsibleContent>
      </Collapsible>
      <Rows items={rest.slice(-SHOWN).map(item)} timezone={timezone} />
    </Group>
  );
}

/** The decision log entries for this card (§4.4: the decision, and when and from which device it was recorded). */
function DecisionLog({ entries, timezone }: { entries: LogEntry[]; timezone: string }) {
  return (
    <Group title="Decision log">
      <table className="w-full text-lead" data-decision-log>
        <thead>
          <tr className="text-left text-meta uppercase tracking-meta text-muted-foreground">
            <th className="pb-1 pr-3 font-normal">When</th>
            <th className="pb-1 pr-3 font-normal">Decision</th>
            <th className="pb-1 font-normal">By</th>
          </tr>
        </thead>
        <tbody className="divide-y border-t">
          {entries.map((e, i) => (
            <tr key={i} className="align-top">
              <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">{when(e.decided_at, timezone)}</td>
              <td className="py-1.5 pr-3">
                {e.decision}
                {e.delegated_to && <span className="text-muted-foreground"> to {e.delegated_to}</span>}
                {e.edited_proposal && <span className="block whitespace-pre-wrap text-muted-foreground">{e.edited_proposal}</span>}
                {e.comment && <span className="block text-muted-foreground">“{e.comment}”</span>}
              </td>
              <td className="py-1.5 text-muted-foreground">{e.by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Group>
  );
}
