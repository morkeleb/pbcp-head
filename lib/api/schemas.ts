// The human API's contract (docs/mobile-prd.md "Human API"): request and response shapes of every /api/me/
// route and of GET /, as Zod schemas. The routes parse their request bodies with these; lib/api/openapi.ts
// turns them into the OpenAPI document in packages/api-types, which the phone's client is generated from; and
// test/http/contract.test.ts checks real responses against that document. The card itself is @pbcp/core's.

import { DecisionSchema, HeadDescriptionSchema, HeadFieldsSchema, KINDS, ProducerCardSchema, STATES, URGENCIES } from '@pbcp/core';
import { z } from 'zod';
import { PAIRING_CODE_SHAPE } from '../pairing-code';
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

const ParagraphEntry = z.object({
  id: z.string().describe('The card the entry is'),
  labels: z.array(z.string()).describe('Its labels (§4.1), for filtering'),
  text: z.string().describe('Safe inline HTML: "<title> — <lead>", the title linked to the card'),
});

export const ParagraphParts = z.object({
  decisions: z.array(ParagraphEntry).describe('Open decisions that are not snoozed'),
  snoozed: z.array(z.array(z.string())).describe('The labels of each snoozed decision: counted, never listed (§8)'),
  decided: z.array(ParagraphEntry).optional().describe('Decisions made the day before: "<title> — decided <value>"'),
  mattered: z.array(ParagraphEntry).optional().describe('The day before’s signals delivered immediate or brief, and brief artifacts from producers that sent at most three cards; newest first. The paragraph names six, then "and N more"'),
  rest: z.array(z.object({ producer: z.string(), labels: z.array(z.string()) })).optional().describe('Every other thread of the day before, counted by producer: "And 9 updates from mail, goalpath and hermes."'),
  yesterday: z.array(ParagraphEntry).optional().describe('Folds before 6 only: the previous day’s threads, one list'),
}).register(responses, { id: 'ParagraphParts', description: 'A daily brief in parts, so a view can keep only the entries of chosen labels and write the same sentences, one paragraph each: "N decisions: <entry>; …." (or "Nothing waiting for you."), "Yesterday you decided: …", "What mattered yesterday: …", "And N updates from …"' });

export const MeCard = Card.extend({
  rendered_html: z.string().describe('The body rendered on receipt and sanitised (RFC §3.1). Show this; never render `body` yourself.'),
  lead: z.string().describe('The card’s lead (RFC 0.6 §3.1, core’s `leadOf`): its `summary` when it has one, otherwise the body’s first paragraph as markdown. Empty when the body has none.'),
  lead_source: z.enum(['summary', 'body']).describe('Where the lead came from: `summary` is plain text, never markdown; `body` is inline markdown'),
  rendered_lead: z.string().describe('The lead as safe inline HTML, rendered by the head: a summary escaped and cut at 280 characters, a body lead rendered inline. Show this beside the title; never render `lead` yourself.'),
  rendered_actions: z.record(z.string(), z.string()).optional().describe('Rendered bodies of choice options (§4.4), by action id'),
  first_visual: Visual.optional().describe('The first diagram or image in the body, for a thumbnail'),
  order_outcome: z.enum(['applied', 'stale']).optional().describe('On an outcome card: whether it moved its order, or came late or from an earlier claim'),
  day: z.string().describe('The card’s day (§8), YYYY-MM-DD: its `about`, else the day of `at`, else of `received_at`, in the head’s timezone when it was stored'),
  paragraph: ParagraphParts.optional().describe('On a `head:daily` card: its paragraph in parts'),
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
  decisions: z
    .array(
      z.object({
        decision: z.string(),
        decided_at: Timestamp,
        edited_proposal: z.string().optional(),
        comment: z.string().optional(),
        delegated_to: z.string().optional(),
        by: z.string().describe('The device that recorded it, by name'),
      }),
    )
    .describe('The decision log entries for this card, oldest first (§4.4)'),
}).register(responses, { id: 'CardDetail' });

export const CardList = z.object({
  cards: z.array(MeCard),
  next: Seq.nullable().describe('Pass as `after` for the next page; null on the last'),
  timezone: Zone,
  before: z
    .string()
    .nullable()
    .optional()
    .describe('With `from`: the latest local day before `from` that has a card, YYYY-MM-DD; null when there is none'),
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
  first_day: z.string().nullable().describe('The local day of the head’s oldest card, YYYY-MM-DD; how far back the timeline goes'),
  daily: MeCard.nullable().describe('The latest `head:daily` card'),
  daily_paragraph: z
    .object({
      html: z.string().describe('Safe inline HTML, the parts’ sentences as one run of prose: "N decisions: <title> — <lead>; …. Yesterday you decided: …. What mattered yesterday: …. And N updates from …." with each title linked to its card; a lead is left out when empty or the same as the title (RFC §8)'),
      so_far: z.boolean().describe('True until today’s `head:daily` card exists: the same fold, made now'),
      parts: ParagraphParts,
    })
    .nullable()
    .describe('The brief today opens with ("Nothing waiting for you." on a quiet day)'),
  tomorrow: z
    .object({ date: z.string().describe('YYYY-MM-DD in `timezone`'), cards: z.array(MeCard).describe('Open cards snoozed until tomorrow, and cards about tomorrow (`thread: day-<date>`)') })
    .describe('What is already set for tomorrow'),
  decisions: z.array(MeCard).describe('Open decisions, newest first, snoozed ones left out'),
  threads: z.array(Fold).describe('Today’s artifacts and signals, folded by thread; immediate first'),
  snoozed: z.number().int().nonnegative(),
  late_outcomes: z.array(MeCard).describe('Order outcomes that came late or from an earlier claim (A.3)'),
  lapsed_orders: z.array(MeCard).describe('Orders whose lease lapsed with no outcome (A.2)'),
  new: z.array(z.string()).describe('Ids changed since the last visit'),
}).register(responses, { id: 'Brief' });

export const BriefStamp = z.object({
  seq: Seq.describe('The highest change_seq the head has assigned: it moves with every card stored and every decision'),
  date: z.string().describe('The head’s local date, YYYY-MM-DD: the brief’s `date` changes with it at midnight'),
}).register(responses, { id: 'BriefStamp' });

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

export const Label = z.object({
  label: z.string(),
  cards: z.number().int().nonnegative().describe('How many of the head’s cards carry it'),
  ceiling: z.enum(URGENCIES).nullable().describe('The owner’s ceiling on it (§9), or null'),
}).register(responses, { id: 'Label' });

export const LabelList = z.object({ labels: z.array(Label) }).register(responses, { id: 'LabelList' });

export const LabelPatch = z.object({
  ceiling: z.enum(URGENCIES).nullable().describe('Lowers the delivery of cards carrying the label, stored from now on; null clears it (§9)'),
}).register(requests, { id: 'LabelPatch' });

export const Device = z.object({
  id: z.string(),
  name: z.string().nullable(),
  platform: z.enum(['web', 'ios', 'android', 'mcp']).describe('`mcp`: an assistant connected through OAuth (/api/mcp)'),
  created_at: Timestamp,
  last_seen_at: Timestamp.nullable(),
  timezone: Zone.nullable().describe('The zone it last sent in X-Timezone'),
  timezone_seen_at: Timestamp.nullable(),
  current: z.boolean().describe('The device making this request'),
  daily_notification: z.object({
    enabled: z.boolean(),
    time: z.string().describe('HH:MM, a quarter hour, in the device’s timezone (default 07:00)'),
    subscribed: z.boolean().describe('The device has a Web Push subscription the head can send to'),
  }).describe('The daily “brief is ready” notification (Settings → Devices)'),
  urgent_notification: z.object({
    enabled: z.boolean(),
    subscribed: z.boolean().describe('The device has a Web Push subscription the head can send to'),
  }).describe('A push for each card stored with delivery immediate (§9), off by default'),
}).register(responses, { id: 'Device' });

export const DevicePatch = z.object({
  daily_notification: z.object({
    enabled: z.boolean().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/).optional().describe('HH:MM on a quarter hour'),
  }).optional(),
  urgent_notification: z.object({ enabled: z.boolean() }).optional(),
}).register(requests, { id: 'DevicePatch' });

export const PushSubscription = z.object({
  endpoint: z.string().describe('The push service URL (https)'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
}).register(requests, { id: 'PushSubscription' });

export const InviteBody = z.object({ email: z.string().describe('An email address, at most 254 characters (400 `invalid_email`)') }).register(requests, { id: 'InviteBody' });

export const InviteAccepted = z.object({ requested: z.literal(true) }).register(responses, { id: 'InviteAccepted' });

export const InviteList = z.object({
  requests: z.array(z.object({ id: z.string(), email: z.string(), created_at: Timestamp, user_agent: z.string().nullable() })),
}).register(responses, { id: 'InviteList' });

export const PushKey = z.object({ public_key: z.string().describe('The VAPID public key, base64url: the applicationServerKey') }).register(responses, { id: 'PushKey' });

export const DeviceList = z.object({ devices: z.array(Device) }).register(responses, { id: 'DeviceList' });

// --- settings (/api/me/settings/*) -------------------------------------------------------------------------

export const HeadFacts = z.object({
  owner: z.string().describe('The owner’s person id: every card’s `to_person` (§10)'),
  url: z.string().describe('The head URL a producer is given: the origin plus /api'),
  protocol: z.string(),
  extensions: z.array(z.string()),
  render: z.object({ mermaid: z.array(z.string()) }),
}).register(responses, { id: 'HeadFacts', description: 'The describe document’s facts (§7.5) and where producers submit' });

export const ProducerToken = z.object({
  id: z.string().describe('The token’s id here: a prefix of its stored hash, never the token'),
  root: z.string(),
  name: z.string().nullable().describe('The name shown in Settings, 1–60 characters: renamed there, or the name a paired producer gave. Null: shown as the root'),
  instance: z.string().nullable(),
  executor: z.boolean(),
  ceiling: z.enum(URGENCIES),
  created_at: Timestamp,
  last_used_at: Timestamp.nullable().describe('The last request it authenticated, to the minute'),
  paired: z
    .object({ name: z.string().nullable(), address: z.string().nullable(), at: Timestamp })
    .nullable()
    .describe('When the producer minted this token itself with a pairing code: the name it gave, its address, when'),
}).register(responses, { id: 'ProducerToken' });

export const ProducerTokenList = z.object({ producers: z.array(ProducerToken) }).register(responses, { id: 'ProducerTokenList' });

export const MintTokenRequest = z.object({
  root: z.string().describe('The producer root (§5): letters, digits and -; not `head`; not already held by a live token'),
  ceiling: z.enum(URGENCIES).optional().describe('Default `brief` (§9)'),
  executor: z.boolean().optional().describe('May claim orders to `*` (A.1)'),
  instance: z.string().optional().describe('A second installation of the same connector'),
}).register(requests, { id: 'MintTokenRequest' });

export const MintedToken = z.object({
  token: z.string().describe('The producer token. Shown once: the head keeps only its hash'),
  producer: ProducerToken,
}).register(responses, { id: 'MintedToken' });

export const TokenPatch = z.object({
  ceiling: z.enum(URGENCIES).optional().describe('The producer’s ceiling (§9): every live token of its root; cards stored from now on'),
  name: z.string().optional().describe('The name shown in Settings: 1–60 characters, trimmed (400 `invalid_name`). The root never changes'),
}).refine((p) => p.ceiling !== undefined || p.name !== undefined, 'give ceiling, name, or both').register(requests, { id: 'TokenPatch' });

export const PairingCode = z.object({
  id: z.string().describe('Names the code to cancel it; not the code'),
  created_at: Timestamp,
  expires_at: Timestamp,
}).register(responses, { id: 'PairingCode' });

export const PairingCodeList = z.object({ codes: z.array(PairingCode).describe('Codes not yet used, cancelled or expired') }).register(responses, { id: 'PairingCodeList' });

export const NewPairingCode = PairingCode.extend({
  code: z.string().describe(`The code: ${PAIRING_CODE_SHAPE}, e.g. K7Q-4MX. In this answer only`),
  api: z.string().describe('Where the agent pairs: POST {api}/pair'),
  say: z.string().describe('The sentence to give the agent: "Pair with <api>, code <code>."'),
}).register(responses, { id: 'NewPairingCode' });

export const PairRequest = z.object({
  code: z.string().describe(`The code the owner gave you: ${PAIRING_CODE_SHAPE}. Case does not matter`),
  root: z.string().describe('The root you choose (RFC §5): letters, digits and -; every card id you send starts with it'),
  name: z.string().optional().describe('What you are, for the owner’s record'),
}).register(requests, { id: 'PairRequest' });

export const Paired = z.object({
  token: z.string().describe('Your producer token. Shown once: the head keeps only its hash'),
  api: z.string().describe('The base URL of the producer operations (§7.5)'),
  owner: z.string().describe('The owner’s person id: every card’s to_person (§10)'),
  root: z.string(),
}).register(responses, { id: 'Paired' });

export const Enrolment = z.object({
  url: z.string().describe('Opens the sign-in page ready to register a passkey on this head'),
  expires_at: Timestamp,
}).register(responses, { id: 'Enrolment' });

export const ConnectSnippets = z.object({
  api: z.string().describe('The base URL of the producer operations (§7.5 `api`)'),
  owner: z.string(),
  token: z.string().describe('The placeholder in `config` and `curl`: replace it with a token just minted'),
  config: z.object({ PBCP_HEAD_URL: z.string(), PBCP_TO_PERSON: z.string(), PBCP_TOKEN: z.string() }).describe('`producerConfig` (@pbcp/client): the three values every producer needs'),
  curl: z.string().describe('`curlSnippet` (@pbcp/client): a curl that PUTs a card'),
  curl_root: z.string().describe('The root of the curl’s card: its token must be bound to it (§12)'),
  connectors: z.array(z.object({ name: z.string(), url: z.string().describe('Its README’s Setup section in the protocol repository') })),
}).register(responses, { id: 'ConnectSnippets' });

// --- GET / ----------------------------------------------------------------------------------------------

export const HeadDescription = HeadDescriptionSchema.register(responses, { id: 'HeadDescription', description: 'RFC §7.5' });
