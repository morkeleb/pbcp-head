// The front door's demo brief: the demo scenario (lib/demo/scenario.ts) replayed in memory through @pbcp/core, as a
// head would store it, and shown as the brief shows a real head's: each card rendered by the head's own pipeline
// (lib/render: markdown, sanitiser, mermaid drawn by the draw route), its day placed by §8, its delivery set by §9
// under the demo producers' ceilings, decisions and orders through core's lifecycle. Nothing is stored: no head, no
// card rows; only drawn diagrams land in the shared diagram cache, as for any card. No signed-in data is read.
//
// One replay per local date, kept in memory: the page is the same for every visitor that day.

import { applyOutcome, checkOutcome, claim, decide, mintOrder, parseCardOrThrow, submit, type Card, type OrderCard, type ProducerCard } from '@pbcp/core';
import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/client';
import { dailyLines, paragraphParts } from '../brief/fold';
import { renderParts } from '../brief/nightly';
import { composeParagraph, type ParagraphParts } from '../brief/paragraph';
import type { MeCard } from '../me';
import { renderCardContent, renderSource } from '../render';
import { ownOrigin } from '../render/markdown';
import { addDays, byTime, instant, localDate, zonedInstant } from '../time';
import { DEMO_ROOTS, type DemoRoot } from './data';
import { demoScenario, type DemoStep } from './scenario';

/** Where the demo head lives: its owner's id and timezone. Times on the page are this zone's. */
export const DEMO_OWNER = 'you';
export const DEMO_TIMEZONE = 'Europe/Copenhagen';

export interface DemoThread {
  latest: MeCard;
  earlier: Array<{ id: string; title: string; received_at: string; acknowledged_at?: string }>;
}

export interface DemoDay {
  date: string;
  kind: 'today' | 'tomorrow';
  paragraph: { html: string; soFar: boolean; parts: ParagraphParts } | null;
  decisions: MeCard[];
  updates: DemoThread[];
  signals: DemoThread[];
  /** The day's cards with `at`, for its schedule (RFC 0.8 §8), `log` included. */
  rail: MeCard[];
}

export type DemoOrder = MeCard & {
  to_producer: string;
  exec_state: 'open' | 'claimed' | 'done' | 'failed' | 'cancelled';
  claimed_by?: string;
  claim_expires_at?: string;
  claim_seq?: number;
  progress: { count: number; latest: MeCard | null };
};

export interface DemoHead {
  date: string;
  timezone: string;
  today: DemoDay;
  tomorrow: DemoDay;
  orders: DemoOrder[];
  /** The card the "card detail" frame opens: the decision with an editable proposal. */
  detail: MeCard;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const ulidNow = (at: string) => {
  // Crockford base32 of the time and 80 random bits (A.1 order ids); core checks the shape.
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.parse(at);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + [...randomBytes(16)].map((b) => B32[b % 32]).join('');
};

/** The scenario as a head would hold it: every card as stored, with its §8 day. */
export function replay(today: string, timezone = DEMO_TIMEZONE): { cards: Map<string, Card>; days: Map<string, string> } {
  const cards = new Map<string, Card>();
  const days = new Map<string, string>();
  let seq = 0;
  const persist = (c: Card) => {
    const stored = { ...c, change_seq: ++seq } as Card;
    cards.set(c.id, stored);
    if (!days.has(c.id)) days.set(c.id, stored.about ?? localDate(instant(stored.at ?? stored.received_at), timezone)); // §8
    return stored;
  };
  const at = (time: string) => iso(zonedInstant(today, time, timezone));

  const put = (root: DemoRoot, fields: Record<string, unknown>, time: string) => {
    const now = at(time);
    const incoming = parseCardOrThrow({ protocol: 'pbcp/1', producer: root, to_person: DEMO_OWNER, emitted_at: now, ...fields }) as ProducerCard;
    const target = incoming.supersedes ? (cards.get(incoming.supersedes) ?? null) : null;
    const ceiling = (DEMO_ROOTS[root] as { ceiling?: Card['urgency'] }).ceiling ?? 'brief';
    const r = submit(cards.get(incoming.id) ?? null, incoming, now, target, ceiling);
    for (const c of r.changed) persist(c);
    // A.3: an outcome moves its order when it comes from the current lease.
    const order = checkOutcome(incoming);
    const held = order ? (cards.get(order) as OrderCard | undefined) : undefined;
    if (held) for (const c of applyOutcome(held, incoming, now).changed) persist(c as unknown as Card);
  };

  for (const step of demoScenario(today, timezone) as DemoStep[]) {
    if ('put' in step) put(step.put, step.card, step.at);
    else if ('decide' in step) {
      const stored = cards.get(step.decide);
      if (stored) for (const c of decide(stored, { decision: step.decision }, at(step.at)).changed) persist(c);
    } else {
      const now = at(step.at);
      const { order } = mintOrder({ ...step.order, to_producer: step.order.to }, { ulid: ulidNow(now), now, executors: [] });
      persist(order as unknown as Card);
      const { root, steps, done } = step.work;
      const claimed = claim(order, root, done ? 300 : 86_400, at(step.work.at));
      for (const c of claimed.changed) persist(c as unknown as Card);
      const s = (claimed.card as OrderCard).claim_seq!;
      const key = order.id.split(':')[2];
      steps.forEach((note, i) =>
        put(root, { id: `${root}:order:${key}:progress-${s}-${i + 1}`, kind: 'signal', urgency: 'log', thread: order.id, references: [order.id], title: note.split('\n')[0], body: note }, step.work.at),
      );
      if (done) put(root, { id: `${root}:order:${key}:outcome-${s}`, kind: 'signal', thread: order.id, references: [order.id], 'orders.claim_seq': s, 'orders.result': 'done', title: done.title, body: done.body }, done.at);
    }
  }
  return { cards, days };
}

// Rendered once per card content, like the head's own render-on-receipt: a body that does not change is not redrawn.
const rendered = new Map<string, Promise<Awaited<ReturnType<typeof renderCardContent>>>>();

async function present(db: Db, card: Card, day: string): Promise<MeCard> {
  const key = renderSource(card);
  if (!rendered.has(key)) rendered.set(key, renderCardContent(db, card).catch((e) => (rendered.delete(key), Promise.reject(e))));
  const { html, actions, meta } = await rendered.get(key)!;
  return {
    ...card,
    rendered_html: html,
    lead: meta.lead?.text ?? '',
    lead_source: meta.lead?.source ?? 'body',
    rendered_lead: meta.lead?.html ?? '',
    ...(Object.keys(actions).length > 0 ? { rendered_actions: actions } : {}),
    ...(meta.firstVisual ? { first_visual: meta.firstVisual } : {}),
    day,
  };
}

/** Cards sharing producer and thread together, newest last (§8), newest thread first: the brief's threads. */
function threads(cs: MeCard[]): DemoThread[] {
  const groups = new Map<string, MeCard[]>();
  for (const c of [...cs].sort((a, b) => a.change_seq - b.change_seq)) {
    const key = `${c.producer}\u0000${c.thread ?? `\u0001${c.id}`}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()]
    .map((g) => ({ latest: g.at(-1)!, earlier: g.slice(0, -1).map(({ id, title, received_at, acknowledged_at }) => ({ id, title, received_at, ...(acknowledged_at ? { acknowledged_at } : {}) })) }))
    .sort((a, b) => b.latest.change_seq - a.latest.change_seq);
}

const cache = new Map<string, Promise<DemoHead>>();

/** The demo head as of `now`: today's brief, tomorrow, the orders and a card to open. */
export function demoHead(db: Db, now = new Date()): Promise<DemoHead> {
  const date = localDate(now, DEMO_TIMEZONE);
  if (!cache.has(date)) {
    cache.clear();
    cache.set(date, build(db, date).catch((e) => (cache.delete(date), Promise.reject(e))));
  }
  return cache.get(date)!;
}

async function build(db: Db, date: string): Promise<DemoHead> {
  const { cards, days } = replay(date);
  const tomorrowDate = addDays(date, 1);
  const all = [...cards.values()];
  const me = new Map<string, MeCard>();
  for (const c of all) me.set(c.id, await present(db, c, days.get(c.id)!));
  const shown = (pred: (c: MeCard) => boolean) => [...me.values()].filter(pred);
  const fromProducer = (c: MeCard) => c.producer !== 'head';
  const rail = (day: string) => shown((c) => c.day === day && c.at !== undefined && c.state !== 'superseded').sort(byTime);

  // As GET /api/me/brief shows a head: every open decision, newest first; today's artifacts and signals delivered at
  // brief or immediate (a log card is only in the day view, §9), as threads.
  const decisions = shown((c) => c.kind === 'decision' && c.state === 'open').sort((a, b) => b.received_at.localeCompare(a.received_at));
  const todayUpdates = threads(shown((c) => fromProducer(c) && c.state === 'open' && (c.kind === 'artifact' || c.kind === 'signal') && c.delivery !== 'log' && c.day === date));
  const tomorrowCards = shown((c) => fromProducer(c) && c.state === 'open' && c.day === tomorrowDate);

  // The day's paragraph, as the live "so far today" fold makes it (lib/brief/nightly.ts dailyParagraphNow).
  const cardUrl = (id: string) => `${ownOrigin()}/card/${encodeURIComponent(id)}`;
  const yesterday = all.filter((c) => c.producer !== 'head' && days.get(c.id) === addDays(date, -1));
  const parts = await renderParts(db, paragraphParts(dailyLines({ openDecisions: decisions, yesterday, decidedYesterday: [], at: iso(zonedInstant(date, '09:10', DEMO_TIMEZONE)) }), cardUrl));

  const orders: DemoOrder[] = shown((c) => (c.kind as string) === 'order').map((o) => {
    const thread = shown((c) => c.thread === o.id).sort((a, b) => a.change_seq - b.change_seq);
    return { ...(o as DemoOrder), progress: { count: thread.length, latest: thread.at(-1) ?? null } };
  });

  return {
    date,
    timezone: DEMO_TIMEZONE,
    today: {
      date,
      kind: 'today',
      paragraph: { html: composeParagraph(parts), soFar: true, parts },
      decisions,
      updates: todayUpdates.filter((t) => t.latest.kind === 'artifact'),
      signals: todayUpdates.filter((t) => t.latest.kind === 'signal'),
      rail: rail(date),
    },
    tomorrow: {
      date: tomorrowDate,
      kind: 'tomorrow',
      paragraph: null,
      decisions: tomorrowCards.filter((c) => c.kind === 'decision'),
      updates: threads(tomorrowCards.filter((c) => c.kind === 'artifact')),
      signals: threads(tomorrowCards.filter((c) => c.kind === 'signal')),
      rail: rail(tomorrowDate),
    },
    orders,
    detail: me.get('hermes:demo:gmail-19c3a8e05f72:reply')!,
  };
}
