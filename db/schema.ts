// The head's storage (docs/head-skeleton.md, docs/mobile-prd.md "Auth").
//
// Five tables carry the protocol: heads, producer_tokens, cards, change_counter, decision_log.
// Two carry the human side: identities (who may sign in as a head's owner) and devices
// (one row per signed-in client, holding its refresh token).

import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, customType, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const heads = pgTable('heads', {
  id: text('id').primaryKey(), // the owner's person id, e.g. 'morten': stable; what GET / reports as `owner`, and `to_person`
  displayName: text('display_name'), // how the owner is shown in a hosted deployment; never used in the protocol
  createdAt: tstz('created_at').notNull().defaultNow(),
  // The owner's explicit IANA zone. Null: the head follows the device most recently seen (devices.timezone),
  // and UTC when no device has sent one (lib/timezone.ts).
  timezone: text('timezone'),
  // The global "since last visit" cursor (RFC §14 open question; global, per head): the change_seq the
  // owner had seen when they last left the brief.
  lastVisitSeq: bigint('last_visit_seq', { mode: 'number' }).notNull().default(0),
  lastVisitAt: tstz('last_visit_at'),
});

export const producerTokens = pgTable('producer_tokens', {
  tokenHash: bytea('token_hash').primaryKey(), // sha256 of the bearer token; the token itself is never stored
  headId: text('head_id').notNull().references(() => heads.id),
  root: text('root').notNull(), // the one namespace root this token may write (§12)
  instance: text('instance'), // optional principal suffix: two installs of one connector are two principals
  urgencyCeiling: text('urgency_ceiling').notNull().default('brief'), // §9: a new producer defaults to brief
  executor: boolean('executor').notNull().default(false), // eligible for to_producer '*' (A.1, milestone H3)
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastUsedAt: tstz('last_used_at'), // the last request it authenticated, to the minute (lib/auth/producer.ts)
  revokedAt: tstz('revoked_at'),
  // Set when the producer minted this token itself with a pairing code (lib/settings/pairing.ts): who, from where, when.
  pairedName: text('paired_name'),
  pairedAddress: text('paired_address'),
  pairedAt: tstz('paired_at'),
  // The name the owner sees in Settings (1–60 characters), renamed there; a pairing starts it as the name the producer
  // gave. Null: shown as the root. Display only: the root, which the protocol uses, never changes.
  name: text('name'),
});

// OAuth for assistants (lib/oauth): clients registered dynamically (RFC 7591; public clients, no secrets), and
// authorization codes (10 minutes, single use, PKCE S256). The tokens a client gets are a device's (devices,
// platform 'mcp'): an access JWT with scope `owner`, and a rotating refresh token stored hashed on the device.
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name'),
  redirectUris: text('redirect_uris').array().notNull(),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: bytea('code_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.clientId),
  headId: text('head_id').notNull().references(() => heads.id),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope').notNull(),
  resource: text('resource').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  usedAt: tstz('used_at'),
  deviceId: text('device_id'), // the device its exchange made: signed out if the code is presented again
});

// Pairing codes (lib/settings/pairing.ts): made by the owner, given to an agent, which trades one for its own producer
// token at POST /api/pair. Only the code's hash is kept; a code is single use, bound to its head, and short-lived.
export const pairingCodes = pgTable(
  'pairing_codes',
  {
    id: text('id').primaryKey(), // how the owner names it to cancel it; not the code
    headId: text('head_id').notNull().references(() => heads.id),
    codeHash: bytea('code_hash').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'), // paired or cancelled: either way, never again (an expired code is refused by its expires_at)
  },
  (t) => [uniqueIndex('pairing_codes_hash').on(t.codeHash), index('pairing_codes_head').on(t.headId)],
);

export const cards = pgTable(
  'cards',
  {
    headId: text('head_id').notNull().references(() => heads.id),
    id: text('id').notNull(),
    producer: text('producer').notNull(), // denormalised from the id's root
    namespace: text('namespace').notNull(), // the id's second segment
    producerDoc: jsonb('producer_doc').notNull(), // the ProducerCard exactly as accepted; equality is computed on this
    urgency: text('urgency'), // the producer's urgency as sent (null when absent), denormalised from producer_doc
    delivery: text('delivery').notNull(), // §4.2, §9: urgency clamped to the producer's ceiling when the content was stored
    state: text('state').notNull(), // open | decided | superseded
    changeSeq: bigint('change_seq', { mode: 'number' }).notNull(),
    receivedAt: tstz('received_at').notNull(),
    // §8 a card's day: its `about` when it has one, else the day of received_at in the head's effective timezone when it
    // was stored. Head-owned and derived; set on every write (lib/store.ts), never synced.
    day: date('day', { mode: 'string' }).notNull(),
    changedAt: tstz('changed_at').notNull(),
    seenAt: tstz('seen_at'),
    acknowledgedAt: tstz('acknowledged_at'),
    snoozedUntil: tstz('snoozed_until'),
    decision: text('decision'),
    editedProposal: text('edited_proposal'),
    comment: text('comment'),
    decidedAt: tstz('decided_at'),
    delegatedTo: text('delegated_to'),
    decidedDoc: jsonb('decided_doc'), // producer_doc frozen at decision time (§4.4: the head MUST retain that version)
    // Rendered on receipt, server-side (§3.1). Not protocol fields: never synced, never bump change_seq.
    renderedHtml: text('rendered_html'), // the body as safe HTML
    renderedActions: jsonb('rendered_actions'), // { [action id]: html } for choice options with a markdown body (§4.4)
    renderedMeta: jsonb('rendered_meta'), // { firstVisual, fences: [{ type, class }] }
    renderedFrom: text('rendered_from'), // hash of what was rendered (pipeline version, body, option bodies); stale when it differs
    // On a `head:daily` card: its paragraph in parts (lib/brief/paragraph.ts), so a view can filter the entries by label.
    renderedParagraph: jsonb('rendered_paragraph'),
    // Orders extension (A.1). Head-owned fields of an order card; wildcard_eligible is the head-private
    // snapshot of executors eligible when a `*` order was minted, never returned to anyone.
    toProducer: text('to_producer'),
    execState: text('exec_state'),
    claimedBy: text('claimed_by'),
    claimExpiresAt: tstz('claim_expires_at'),
    claimSeq: integer('claim_seq'),
    wildcardEligible: text('wildcard_eligible').array(),
    // On a card that is an order's outcome (A.3): `applied` when it moved exec_state, `stale` when it came
    // from an old or lapsed lease or after the order ended. Head-private; the brief surfaces stale ones.
    outcome: text('outcome'),
  },
  (t) => [
    primaryKey({ columns: [t.headId, t.id] }),
    index('cards_sync').on(t.headId, t.changeSeq),
    index('cards_received').on(t.headId, t.receivedAt),
    index('cards_day').on(t.headId, t.day), // the timeline by day (§8), and where it begins
    index('cards_thread').on(t.headId, t.producer, sql`(${t.producerDoc}->>'thread')`),
    index('cards_orders').on(t.headId, t.toProducer, t.changeSeq),
  ],
);

// One strictly increasing counter per head (§7.2). Every write takes this row with FOR UPDATE first,
// so writes to one head are serialised and commit in change_seq order: a sync can never see seq n+1
// while n is still uncommitted.
export const changeCounter = pgTable('change_counter', {
  headId: text('head_id').primaryKey().references(() => heads.id),
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
});

// §9: the owner MAY set a ceiling per label; a card under a producer ceiling and label ceilings gets the lowest.
export const labelCeilings = pgTable(
  'label_ceilings',
  {
    headId: text('head_id').notNull().references(() => heads.id),
    label: text('label').notNull(),
    ceiling: text('ceiling').notNull(), // log | brief | immediate
  },
  (t) => [primaryKey({ columns: [t.headId, t.label] })],
);

// Append-only. The decision and the exact card it was made on (§4.4, §11.3), and who made it.
export const decisionLog = pgTable(
  'decision_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    headId: text('head_id').notNull().references(() => heads.id),
    cardId: text('card_id').notNull(),
    decision: text('decision').notNull(),
    editedProposal: text('edited_proposal'),
    comment: text('comment'),
    delegatedTo: text('delegated_to'),
    decidedAt: tstz('decided_at').notNull(),
    decidedDoc: jsonb('decided_doc').notNull(),
    actor: text('actor').notNull(), // the device id that recorded the decision (mobile PRD, Auth decision 4)
  },
  (t) => [index('decision_log_card').on(t.headId, t.cardId)],
);

// Who may sign in as a head's owner: one row per Apple subject or passkey credential.
export const identities = pgTable(
  'identities',
  {
    id: text('id').primaryKey(),
    headId: text('head_id').notNull().references(() => heads.id),
    provider: text('provider').notNull(), // apple | passkey
    subject: text('subject').notNull(), // Apple `sub`, or the passkey credential id (base64url)
    credential: jsonb('credential'), // passkey only: public key, signature counter, transports
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastUsedAt: tstz('last_used_at'),
  },
  (t) => [uniqueIndex('identities_provider_subject').on(t.provider, t.subject)],
);

// A signed-in client. The refresh token is stored hashed and rotated on every use; revoking the row
// signs the device out.
export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    headId: text('head_id').notNull().references(() => heads.id),
    identityId: text('identity_id').references(() => identities.id),
    name: text('name'),
    platform: text('platform').notNull(), // web | ios | android
    refreshTokenHash: bytea('refresh_token_hash'),
    // Refresh tokens come in a family per device, numbered by generation: `pbcp_rt_<family>.<generation>.<random>`. The
    // current one's hash is refresh_token_hash; presenting any earlier generation of the family revokes the device.
    refreshFamily: text('refresh_family'),
    refreshGeneration: integer('refresh_generation').notNull().default(0),
    refreshExpiresAt: tstz('refresh_expires_at'),
    pushToken: text('push_token'),
    // Web Push (lib/push): the subscription the device's service worker made, removed when the push service says it is
    // gone (404/410). One per device; subscribing again replaces it.
    pushEndpoint: text('push_endpoint'),
    pushP256dh: text('push_p256dh'),
    pushAuth: text('push_auth'),
    pushSubscribedAt: tstz('push_subscribed_at'),
    pushUserAgent: text('push_user_agent'),
    // The daily "brief is ready" notification: on or off, at a local time in minutes after midnight (a quarter hour) in
    // the device's timezone, and the local date it was last sent for, so a cron re-run never sends twice.
    notifyDaily: boolean('notify_daily').notNull().default(false),
    notifyAtMinutes: integer('notify_at_minutes').notNull().default(7 * 60),
    lastNotifiedOn: date('last_notified_on', { mode: 'string' }),
    // A push for each card stored with delivery immediate (§9, after the ceiling; lib/push/urgent.ts). Off by default.
    notifyUrgent: boolean('notify_urgent').notNull().default(false),
    timezone: text('timezone'), // the IANA zone the device last sent in X-Timezone
    clientId: text('client_id'), // platform 'mcp': the OAuth client it was authorised for (lib/oauth)
    tzSeenAt: tstz('tz_seen_at'), // when it last sent one: the most recent of these is the active device
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [uniqueIndex('devices_refresh').on(t.refreshTokenHash), uniqueIndex('devices_refresh_family').on(t.refreshFamily), index('devices_head').on(t.headId)],
);

// Drawn diagrams by sha256 of the sanitised fence (§3.1 Determinism): identical fences across cards and
// re-PUTs are drawn once. A fence mermaid refused is cached with its message, so it is not retried either.
export const diagrams = pgTable('diagrams', {
  hash: text('hash').primaryKey(),
  type: text('type').notNull(),
  svg: text('svg'),
  error: text('error'),
  // The same fence drawn in mermaid's dark theme, for a dark page (null until drawn; a refusal is kept like `error`).
  svgDark: text('svg_dark'),
  errorDark: text('error_dark'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Rate limits (RFC §7.1 `429`; docs/deploy.md): a fixed-window counter per bucket and key (a producer
// token's hash, or a client address). Kept in Postgres because a serverless head has no shared memory;
// expired windows are swept by the requests themselves (no worker).
export const rateLimits = pgTable(
  'rate_limits',
  {
    bucket: text('bucket').notNull(),
    key: text('key').notNull(),
    windowStart: tstz('window_start').notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.key, t.windowStart] }), index('rate_limits_expiry').on(t.expiresAt)],
);

/** When each cron job last ran (lib/push/daily.ts): the window a run covers starts where the last one ended. */
export const cronRuns = pgTable('cron_runs', {
  name: text('name').primaryKey(),
  lastRunAt: tstz('last_run_at').notNull(),
});

/**
 * Requests for an invite to the hosted head, from the front door's form (POST /api/invite): the address and when, and
 * the browser it came from. Deployment-wide, not a head's; the deployment's own head (PBCP_HEAD, or its only head) sees
 * them in Settings. No mail is sent. One row per address: asking again changes nothing.
 */
export const inviteRequests = pgTable(
  'invite_requests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    email: text('email').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('invite_requests_email').on(sql`lower(${t.email})`)],
);
