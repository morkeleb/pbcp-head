// The owner's tools, for an assistant reading the brief to its owner and recording what they decide. Each is one call
// (or a few) to the owner's API, /api/me; results are compact JSON. Card bodies are markdown, as the producer wrote
// them; nothing here returns HTML.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HeadError, unwrap, type MeCard, type OwnerClient, type Schemas } from './client';

type Thread = Schemas['Brief']['threads'][number];
type ActionEntry = NonNullable<MeCard['actions']>[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Text from the head's inline HTML (the daily paragraph): tags dropped, entities decoded. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A decision's choices (RFC §4.4): its actions, or approve and reject when it names none; the default marked. `edit` is not a choice. */
export function choices(card: Pick<MeCard, 'actions'>): Array<{ id: string; label: string; default?: true }> {
  const entries: ActionEntry[] = card.actions ?? ['approve', 'reject'];
  return entries
    .map((a) => (typeof a === 'string' ? { id: a, label: a } : { id: a.id, label: a.label ?? a.id, ...(a.default ? { default: true as const } : {}) }))
    .filter((a) => a.id !== 'edit');
}

const editable = (card: Pick<MeCard, 'actions'>) => (card.actions ?? []).some((a) => a === 'edit');

const decisionRow = (c: MeCard) => ({
  id: c.id,
  producer: c.producer,
  title: c.title,
  lead: c.lead ?? '',
  ...(c.labels?.length ? { labels: c.labels } : {}),
  ...(c.about ? { about: c.about } : {}),
  ...(c.at ? { at: c.at, ...(c.until ? { until: c.until } : {}) } : {}),
  actions: choices(c),
  ...(editable(c) ? { editable: true } : {}),
  ...(c.state !== 'open' ? { state: c.state, decision: c.decision } : {}),
});

const updateRow = (latest: MeCard, count: number) => ({
  id: latest.id,
  producer: latest.producer,
  title: latest.title,
  lead: latest.lead ?? '',
  ...(latest.labels?.length ? { labels: latest.labels } : {}),
  ...(count > 1 ? { in_thread: count } : {}),
  ...(latest.acknowledged_at ? { acknowledged: true } : {}),
});

const row = (c: MeCard) => ({
  id: c.id,
  day: c.day,
  kind: c.kind,
  producer: c.producer,
  title: c.title,
  state: c.state,
  ...(c.labels?.length ? { labels: c.labels } : {}),
  ...(c.decision ? { decision: c.decision } : {}),
  ...(c.acknowledged_at ? { acknowledged: true } : {}),
});

const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** A refusal in the head's words, for the model to say back; never thrown past the tool. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await fn());
  } catch (e) {
    if (e instanceof HeadError) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.code, message: e.message, status: e.status }) }] };
    throw e;
  }
}

async function allCards(client: OwnerClient, query: { date?: string; from?: string; to?: string; state?: 'open' | 'decided' | 'superseded' }): Promise<MeCard[]> {
  const out: MeCard[] = [];
  for (let after: number | null = 0; after !== null; ) {
    const page: Schemas['CardList'] = unwrap(await client.GET('/api/me/cards', { params: { query: { ...query, limit: 200, ...(after ? { after } : {}) } } }));
    out.push(...page.cards);
    after = page.next;
  }
  return out;
}

/** Cards sharing producer and thread, newest last; a card without a thread is its own (RFC §8). */
function folded(cards: MeCard[]) {
  const groups = new Map<string, MeCard[]>();
  for (const c of [...cards].sort((a, b) => a.change_seq - b.change_seq)) {
    const key = `${c.producer}\u0000${c.thread ?? `\u0001${c.id}`}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].map((cs) => updateRow(cs.at(-1)!, cs.length));
}

export function registerOwnerTools(server: McpServer, client: OwnerClient): void {
  server.registerTool(
    'brief',
    {
      title: 'Read the brief',
      description:
        'The owner’s brief for today, or for an earlier `day` (YYYY-MM-DD). Start here when the owner asks what is new or what needs them. ' +
        '`paragraph` is the day’s summary in one paragraph, written to be read aloud as it is. `decisions` are the questions waiting for the owner, newest first: ' +
        'read each one’s title and lead, then its choices (`actions`, the one marked `default` is what the producer proposes); never decide on the owner’s behalf ' +
        'without asking them. `updates` (artifacts) and `signals` are folded by thread, the newest card of each with how many came in it. `snoozed` counts decisions ' +
        'set aside until later; they are not listed. For an earlier day, `decisions` are those decided that day.',
      inputSchema: { day: z.string().regex(DATE).optional().describe('YYYY-MM-DD; today when omitted') },
      annotations: { readOnlyHint: true },
    },
    ({ day }) =>
      run(async () => {
        const b: Schemas['Brief'] = unwrap(await client.GET('/api/me/brief'));
        const split = (ts: Thread[], kind: string) => ts.filter((t) => t.latest.kind === kind).map((t) => updateRow(t.latest, t.count));
        if (day === undefined || day === b.date) {
          return {
            date: b.date,
            paragraph: b.daily_paragraph ? plainText(b.daily_paragraph.html) : null,
            decisions: b.decisions.map(decisionRow),
            updates: split(b.threads, 'artifact'),
            signals: split(b.threads, 'signal'),
            snoozed: b.snoozed,
            ...(b.tomorrow.cards.length ? { tomorrow: b.tomorrow.cards.map(row) } : {}),
          };
        }
        const cards = await allCards(client, { date: day });
        const daily = cards.find((c) => c.id === `head:daily:${day}`);
        const others = cards.filter((c) => c.producer !== 'head');
        return {
          date: day,
          paragraph: daily?.rendered_lead ? plainText(daily.rendered_lead) : null,
          decisions: others.filter((c) => c.kind === 'decision' && c.state !== 'open').map(decisionRow),
          updates: folded(others.filter((c) => c.kind === 'artifact')),
          signals: folded(others.filter((c) => c.kind === 'signal')),
        };
      }),
  );

  server.registerTool(
    'list_cards',
    {
      title: 'List cards',
      description:
        'Cards by their day (an `about` date when the producer gave one, else the day of its time `at`, else the day they arrived), as compact rows: id, day, kind, producer, title, state, labels. ' +
        'Use it to answer questions such as “what did GoalPath send this week” or “which billing decisions are still open”: give a day range and narrow by ' +
        '`label`, `producer`, `kind` (decision, artifact, signal, order) or `state` (open, decided, superseded). Without a range it covers the last seven days. ' +
        'Then call get_card for the one the owner wants to hear in full.',
      inputSchema: {
        from: z.string().regex(DATE).optional().describe('First day, YYYY-MM-DD'),
        to: z.string().regex(DATE).optional().describe('Last day, YYYY-MM-DD; defaults to `from`, or today'),
        label: z.string().optional(),
        producer: z.string().optional(),
        kind: z.enum(['decision', 'artifact', 'signal', 'order']).optional(),
        state: z.enum(['open', 'decided', 'superseded']).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many rows, newest first (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    (q) =>
      run(async () => {
        let { from, to } = q;
        if (!from) {
          const today = (unwrap(await client.GET('/api/me/brief')) as Schemas['Brief']).date;
          to ??= today;
          const d = new Date(`${to}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() - 6);
          from = d.toISOString().slice(0, 10);
        }
        to ??= from;
        const cards = (await allCards(client, { from, to, ...(q.state ? { state: q.state } : {}) }))
          .filter((c) => (!q.label || c.labels?.includes(q.label)) && (!q.producer || c.producer === q.producer) && (!q.kind || c.kind === q.kind))
          .sort((a, b) => b.change_seq - a.change_seq);
        const limit = q.limit ?? 50;
        return { from, to, count: cards.length, cards: cards.slice(0, limit).map(row), ...(cards.length > limit ? { more: cards.length - limit } : {}) };
      }),
  );

  server.registerTool(
    'get_card',
    {
      title: 'Read a card',
      description:
        'One card in full: its body as the producer wrote it (markdown), its choices if it is a decision, its source link, the other cards of its thread, ' +
        'and the decision log (what was decided, when, from which device). Read the body to the owner in your own words if it is long; the `summary`, when there ' +
        'is one, is the producer’s own short version. Use the id from brief or list_cards.',
      inputSchema: { id: z.string().describe('The card id, e.g. hermes:gmail:19a4f2e7c3b1') },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => {
        const d: Schemas['CardDetail'] = unwrap(await client.GET('/api/me/cards/{id}', { params: { path: { id } } }));
        const c = d.card;
        return {
          card: {
            id: c.id,
            kind: c.kind,
            producer: c.producer,
            title: c.title,
            ...(c.summary ? { summary: c.summary } : {}),
            body: c.body,
            state: c.state,
            day: c.day,
            ...(c.labels?.length ? { labels: c.labels } : {}),
            ...(c.about ? { about: c.about } : {}),
            ...(c.at ? { at: c.at, ...(c.until ? { until: c.until } : {}) } : {}),
            ...(c.source ? { source: c.source } : {}),
            ...(c.kind === 'decision' ? { actions: choices(c), ...(editable(c) ? { editable: true } : {}) } : {}),
            ...(c.decision ? { decision: c.decision, decided_at: c.decided_at } : {}),
            ...(c.snoozed_until ? { snoozed_until: c.snoozed_until } : {}),
            ...(c.acknowledged_at ? { acknowledged_at: c.acknowledged_at } : {}),
            ...(c.exec_state ? { exec_state: c.exec_state } : {}),
            received_at: c.received_at,
          },
          ...(d.thread.length > 1 ? { thread: d.thread.map((t) => ({ id: t.id, title: t.title, state: t.state, ...(t.decision ? { decision: t.decision } : {}) })) } : {}),
          ...(d.decisions.length ? { decisions: d.decisions } : {}),
        };
      }),
  );

  server.registerTool(
    'decide',
    {
      title: 'Record a decision',
      description:
        'Record the owner’s decision on an open decision card, and only once they have said what they decide. `decision` is one of the card’s action ids ' +
        '(see brief or get_card), or `dismissed` to set it aside unanswered. To answer with different words than the proposal, pass `edited` with the owner’s ' +
        'text (only when the card is editable). `comment` passes a note to the producer. The producer acts on the decision; it cannot be changed afterwards. ' +
        'If the card is no longer open, the head says so and what was decided.',
      inputSchema: {
        id: z.string(),
        decision: z.string().describe('An action id from the card, or `dismissed`'),
        comment: z.string().optional(),
        edited: z.string().optional().describe('The owner’s own version of the proposal; records the decision `edited`'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    ({ id, decision, comment, edited }) =>
      run(async () => {
        const body = edited !== undefined ? { decision: 'edited', edited_proposal: edited, ...(comment ? { comment } : {}) } : { decision, ...(comment ? { comment } : {}) };
        const c: Schemas['Card'] = unwrap(await client.POST('/api/me/cards/{id}/decision', { params: { path: { id } }, body: body as Schemas['DecisionRequest'] }));
        return { id: c.id, state: c.state, decision: c.decision, decided_at: c.decided_at, ...(c.comment ? { comment: c.comment } : {}), ...(c.edited_proposal ? { edited_proposal: c.edited_proposal } : {}) };
      }),
  );

  server.registerTool(
    'acknowledge',
    {
      title: 'Acknowledge',
      description: 'Mark an update or signal as seen and dealt with, once the owner has heard it. Decisions are decided, not acknowledged.',
      inputSchema: { id: z.string() },
      annotations: { idempotentHint: true },
    },
    ({ id }) =>
      run(async () => {
        const c: Schemas['Card'] = unwrap(await client.POST('/api/me/cards/{id}/ack', { params: { path: { id } } }));
        return { id: c.id, acknowledged_at: c.acknowledged_at };
      }),
  );

  server.registerTool(
    'snooze',
    {
      title: 'Snooze',
      description:
        'Set an open card aside until a later time, when the owner asks to deal with it later: it leaves the brief until then and comes back on its own. ' +
        '`until` is an ISO 8601 timestamp in UTC, ending in Z, in the future (for example 2026-10-28T07:00:00Z for tomorrow morning in Copenhagen).',
      inputSchema: { id: z.string(), until: z.string().describe('UTC, e.g. 2026-10-28T07:00:00Z') },
      annotations: { idempotentHint: true },
    },
    ({ id, until }) =>
      run(async () => {
        const c: Schemas['Card'] = unwrap(await client.POST('/api/me/cards/{id}/snooze', { params: { path: { id } }, body: { until } }));
        return { id: c.id, snoozed_until: c.snoozed_until };
      }),
  );

  server.registerTool(
    'unsnooze',
    {
      title: 'Unsnooze',
      description: 'Bring a snoozed card back into the brief now.',
      inputSchema: { id: z.string() },
      annotations: { idempotentHint: true },
    },
    ({ id }) =>
      run(async () => {
        const c: Schemas['Card'] = unwrap(await client.POST('/api/me/cards/{id}/unsnooze', { params: { path: { id } } }));
        return { id: c.id, state: c.state, snoozed_until: c.snoozed_until ?? null };
      }),
  );

  server.registerTool(
    'create_order',
    {
      title: 'Give an order',
      description:
        'Ask one of the owner’s producers to do something, in the owner’s words: `title` is the request in one line, `body` any detail. `to_producer` is a ' +
        'producer’s root (for example hermes or todoist), or `*` for whichever executor takes it. The producer reports back with cards in the order’s thread; ' +
        'the owner can cancel it from the brief. Only give an order the owner has asked for.',
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional(),
        to_producer: z.string().describe('A producer root, or * for any executor'),
        urgency: z.enum(['log', 'brief', 'immediate']).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    (o) =>
      run(async () => {
        const c: MeCard = unwrap(await client.POST('/api/me/orders', { body: { title: o.title, to_producer: o.to_producer, ...(o.body ? { body: o.body } : {}), ...(o.urgency ? { urgency: o.urgency } : {}) } }));
        return { id: c.id, to_producer: c.to_producer, exec_state: c.exec_state, title: c.title };
      }),
  );

}

export const TOOL_NAMES = ['brief', 'list_cards', 'get_card', 'decide', 'acknowledge', 'snooze', 'unsnooze', 'create_order'] as const;
