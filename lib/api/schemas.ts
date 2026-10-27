// The human API's contract (docs/mobile-prd.md "Human API"): request and response shapes of every /api/me/
// route and of GET /, as Zod schemas. The routes parse their request bodies with these; lib/api/openapi.ts
// turns them into the OpenAPI document in packages/api-types, which the phone's client is generated from; and
// test/http/contract.test.ts checks real responses against that document. The card itself is @pbcp/core's.

import { DecisionSchema, HeadDescriptionSchema, HeadFieldsSchema, KINDS, ProducerCardSchema, STATES, URGENCIES } from '@pbcp/core';
import { z } from 'zod';
import { HttpError } from '../http';

/** Responses: emitted with `additionalProperties: false`, so a field the document does not name is a test failure. */
export const responses = z.registry<{ id: string; description?: string }>();
/** Request bodies: emitted without it; the routes ignore fields they do not know. */
export const requests = z.registry<{ id: string; description?: string }>();

/** Snooze presets, in the effective timezone (mobile PRD gesture model: tonight, tomorrow's brief, next week). */
export const SNOOZE_PRESETS = ['tonight', 'tomorrow', 'next-week'] as const;

/** A request body as `schema` describes it, or 400 `invalid_request` naming what is wrong. */
export function parseRequest<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
  throw new HttpError(400, 'invalid_request', issues.join('; '));
}

const Timestamp = z.string().describe('RFC 3339, UTC (`2026-10-07T09:00:00Z`)');
const Zone = z.string().describe('An IANA timezone, e.g. `Europe/Copenhagen`');
const Seq = z.number().int().nonnegative();

// --- errors -------------------------------------------------------------------------------------------

export const ErrorBody = z
  .object({
    error: z.string().describe('A stable code: `invalid_request`, `unauthorized`, `not_found`, `too_large`, `invalid_snooze`, … (RFC §7.4 and the head’s own)'),
    message: z.string().describe('For people; its wording may change'),
  })
  .register(responses, { id: 'Error', description: 'Every refusal from /api/me, and from GET /: RFC §7.4’s error body.' });

// --- cards ----------------------------------------------------------------------------------------------

/** The protocol card (RFC §4.1, §4.2) plus the orders extension's fields (Appendix A). Unknown fields pass through. */
export const Card = ProducerCardSchema.extend({
  kind: z.enum([...KINDS, 'order']),
  to_person: z.string().min(1).optional().describe('The person the card is for; absent on an order, which is addressed to a producer with `to_producer` (A.1)'),
  ...HeadFieldsSchema.shape,
  'orders.claim_seq': z.number().int().positive().optional().describe('On an executor’s outcome card: the claim it reports on (A.3)'),
  'orders.result': z.enum(['done', 'failed']).optional().describe('On an executor’s outcome card: how the run ended (A.3)'),
}).register(responses, {
  id: 'Card',
  description:
    'A card as the protocol defines it (RFC §4): the producer’s fields, the head’s (`state`, `change_seq`, `delivery`, …) and, on an order, the orders extension’s. Producers may add fields of their own, which are kept.',
});

export const Visual = z.object({
  kind: z.enum(['diagram', 'image']),
  src: z.string().describe('A head URL: /api/me/svg/{hash} or /api/me/img?…'),
  caption: z.string(),
}).register(responses, { id: 'Visual' });

export const MeCard = Card.extend({
  rendered_html: z.string().describe('The body rendered on receipt and sanitised (RFC §3.1). Show this; never render `body` yourself.'),
  rendered_actions: z.record(z.string(), z.string()).optional().describe('Rendered bodies of choice options (§4.4), by action id'),
  first_visual: Visual.optional().describe('The first diagram or image in the body, for a thumbnail'),
  order_outcome: z.enum(['applied', 'stale']).optional().describe('On an outcome card: whether it moved its order, or came late or from an earlier claim'),
}).register(responses, { id: 'MeCard', description: 'A card as the owner’s devices show it: the protocol card plus what the head rendered.' });

export const CardSummary = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum([...KINDS, 'order']),
  producer: z.string(),
  state: z.enum(STATES),
  received_at: Timestamp,
  decision: z.string().optional(),
  exec_state: HeadFieldsSchema.shape.exec_state,
  order_outcome: z.enum(['applied', 'stale']).optional(),
}).register(responses, { id: 'CardSummary' });

export const CardDetail = z.object({
  timezone: Zone,
  card: MeCard,
  predecessors: z.array(MeCard).describe('The cards this one supersedes, oldest first'),
  successors: z.array(CardSummary).describe('The cards that supersede it, in order'),
  references: z.array(z.object({ id: z.string(), card: CardSummary.nullable().describe('Null when this head holds no such card') })),
  thread: z.array(CardSummary).describe('Every card of its thread, newest last; for an order, the order first'),
}).register(responses, { id: 'CardDetail' });

export const CardList = z.object({
  cards: z.array(MeCard),
  next: Seq.nullable().describe('Pass as `after` for the next page; null on the last'),
  timezone: Zone,
}).register(responses, { id: 'CardList' });

// --- the brief ------------------------------------------------------------------------------------------

export const LastVisit = z.object({ seq: Seq, at: Timestamp.nullable() }).register(responses, { id: 'LastVisit' });

export const Fold = z.object({
  producer: z.string(),
  thread: z.string().nullable(),
  count: z.number().int().positive(),
  latest: MeCard,
  cards: z.array(z.object({ id: z.string(), title: z.string(), kind: z.string(), received_at: Timestamp, acknowledged_at: Timestamp.optional() })),
}).register(responses, { id: 'Fold', description: 'One producer’s thread today, folded to its newest card (§8).' });

export const Brief = z.object({
  date: z.string().describe('Today, YYYY-MM-DD in `timezone`'),
  timezone: Zone.describe('The effective timezone (see X-Timezone)'),
  seq: Seq.describe('The head’s change counter now; post it to /api/me/visit when the owner leaves'),
  last_visit: LastVisit,
  daily: MeCard.nullable().describe('The latest `head:daily` card'),
  decisions: z.array(MeCard).describe('Open decisions, newest first, snoozed ones left out'),
  threads: z.array(Fold).describe('Today’s artifacts and signals, folded by thread; immediate first'),
  snoozed: z.number().int().nonnegative(),
  late_outcomes: z.array(MeCard).describe('Order outcomes that came late or from an earlier claim (A.3)'),
  lapsed_orders: z.array(MeCard).describe('Orders whose lease lapsed with no outcome (A.2)'),
  new: z.array(z.string()).describe('Ids changed since the last visit'),
}).register(responses, { id: 'Brief' });

export const Visit = LastVisit;

// --- orders ---------------------------------------------------------------------------------------------

export const OrderWithProgress = MeCard.extend({
  progress: z.object({ count: z.number().int().nonnegative(), latest: MeCard.nullable() }),
}).register(responses, { id: 'OrderWithProgress' });

export const OrderList = z.object({ timezone: Zone, orders: z.array(OrderWithProgress) }).register(responses, { id: 'OrderList' });

export const OrderRequest = z.object({
  to_producer: z.string().describe('A producer root, or `*` for any executor (A.1)'),
  title: z.string(),
  body: z.string().optional(),
  urgency: z.enum(URGENCIES).optional(),
}).register(requests, { id: 'OrderRequest' });

// --- owner actions --------------------------------------------------------------------------------------

export const DecisionRequest = DecisionSchema.register(requests, { id: 'DecisionRequest' });

export const SnoozeRequest = z
  .union([
    z.object({ until: z.string().nullable().describe('UTC only (`…Z`), later than now; an offset such as `+02:00` is refused with 400 `invalid_snooze`. Null unsnoozes.') }),
    z.object({ preset: z.enum(SNOOZE_PRESETS).describe('In the effective timezone: tonight 18:00, tomorrow 05:30, next week 05:30') }),
  ])
  .register(requests, { id: 'SnoozeRequest' });

export const VisitRequest = z.object({ seq: Seq.nullable().optional().describe('Default: the head’s counter now') }).register(requests, { id: 'VisitRequest' });

// --- settings, producers, devices ------------------------------------------------------------------------

export const Me = z.object({
  head: z.string().describe('The head id: the owner’s person id, which producers address as `to_person`'),
  display_name: z.string().nullable(),
  device_id: z.string(),
  timezone: Zone.describe('The effective timezone'),
  last_visit: LastVisit,
}).register(responses, { id: 'Me' });

export const Settings = z.object({
  head: z.string().describe('The stable head id (`to_person`); it never changes'),
  display_name: z.string().nullable().describe('How the owner is shown; not used by the protocol'),
  timezone: Zone.describe('The effective timezone: the override if set, else the device most recently seen with X-Timezone, else UTC'),
  timezone_source: z.enum(['override', 'device', 'default']),
  timezone_override: Zone.nullable(),
  device_timezone: z.object({ device_id: z.string(), timezone: Zone, seen_at: Timestamp }).nullable().describe('The most recent zone a device sent'),
}).register(responses, { id: 'Settings' });

export const SettingsPatch = z.object({
  timezone: Zone.nullable().optional().describe('Sets the override, which wins over the devices; null clears it'),
  display_name: z.string().nullable().optional().describe('One line, 1–100 characters; null clears it'),
}).register(requests, { id: 'SettingsPatch' });

export const Producer = z.object({
  root: z.string(),
  ceiling: z.enum(URGENCIES),
  executor: z.boolean(),
  revoked: z.boolean(),
  tokens: z.array(z.object({ instance: z.string().nullable(), ceiling: z.enum(URGENCIES), executor: z.boolean(), created_at: Timestamp, revoked_at: Timestamp.optional() })),
  last_card_at: Timestamp.nullable(),
}).register(responses, { id: 'Producer' });

export const ProducerList = z.object({ producers: z.array(Producer) }).register(responses, { id: 'ProducerList' });

export const ProducerPatch = z.object({
  ceiling: z.enum(URGENCIES).optional().describe('Applies to content stored from now on (§9)'),
  revoked: z.literal(true).optional().describe('Revokes every token of the root; mint a new one to bring it back'),
}).register(requests, { id: 'ProducerPatch' });

export const Device = z.object({
  id: z.string(),
  name: z.string().nullable(),
  platform: z.enum(['web', 'ios', 'android']),
  created_at: Timestamp,
  last_seen_at: Timestamp.nullable(),
  timezone: Zone.nullable().describe('The zone it last sent in X-Timezone'),
  timezone_seen_at: Timestamp.nullable(),
  current: z.boolean().describe('The device making this request'),
}).register(responses, { id: 'Device' });

export const DeviceList = z.object({ devices: z.array(Device) }).register(responses, { id: 'DeviceList' });

// --- GET / ----------------------------------------------------------------------------------------------

export const HeadDescription = HeadDescriptionSchema.register(responses, { id: 'HeadDescription', description: 'RFC §7.5' });
