// The OpenAPI 3.1 document for the human API (/api/me/) and GET /, built from lib/api/schemas.ts.
// `pnpm api:generate` writes it to packages/api-types/openapi.json; test/api-types.test.ts fails when that
// file is stale.

import { z } from 'zod';
import * as S from './schemas';

type Json = Record<string, unknown>;
const ref = (schema: z.ZodType, registry = S.responses) => ({ $ref: `#/components/schemas/${registry.get(schema)!.id}` });
const json = (schema: z.ZodType, registry = S.responses) => ({ content: { 'application/json': { schema: ref(schema, registry) } } });

const TIMEZONE_DESCRIPTION =
  'The IANA timezone the device is in now, e.g. `Europe/Copenhagen`. Optional on every /api/me request. ' +
  'It is stored on the calling device, and the head follows the zone of the device most recently seen with it ' +
  '(for the brief and its days, snooze presets and the nightly card) unless the owner set an override in ' +
  '/api/me/settings. An unknown zone, or a bare offset such as `+02:00`, is 400 `invalid_request`, checked after the credential.';

const errors = (...statuses: number[]) =>
  Object.fromEntries(
    statuses.map((s) => [
      String(s),
      {
        description: {
          400: 'The request is malformed (`invalid_request`, `malformed_json`, or a protocol code)',
          401: '`unauthorized`: no session, an expired one, a signed-out device, or a producer token',
          403: '`forbidden`',
          404: '`not_found`',
          409: 'The card is no longer open; the body is the stored card',
          413: '`too_large`: the body is over 1 MiB',
          502: '`image_unavailable`: the image could not be fetched, or is not an image of at most 2 MB',
        }[s],
        ...(s === 409 ? json(S.Card) : json(S.ErrorBody)),
      },
    ]),
  );

const idParam = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
const CARD_ID = idParam('id', 'A card id, percent-encoded (it contains `:`)');

interface Op {
  summary: string;
  description?: string;
  parameters?: Json[];
  body?: z.ZodType;
  ok: Json;
  errors: number[];
  public?: true;
}

function operation(id: string, op: Op): Json {
  return {
    operationId: id,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.public ? { security: [] } : {}),
    parameters: [...(op.public ? [] : [{ $ref: '#/components/parameters/XTimezone' }]), ...(op.parameters ?? [])],
    ...(op.body ? { requestBody: { required: true, ...json(op.body, S.requests) } } : {}),
    responses: { ...op.ok, ...errors(...op.errors) },
  };
}

const ok = (schema: z.ZodType, description = 'OK', status = 200) => ({ [String(status)]: { description, ...json(schema) } });
const cardResult = { ...ok(S.Card, 'The card as stored: the protocol card, without what the head rendered') };

const PATHS: Record<string, Record<string, Json>> = {
  '/': {
    get: operation('describeHead', { summary: 'Describe the head (RFC §7.5)', ok: ok(S.HeadDescription), errors: [404], public: true }),
  },
  '/api/me': {
    get: operation('getMe', { summary: 'Who is signed in', ok: ok(S.Me), errors: [400, 401] }),
  },
  '/api/me/settings': {
    get: operation('getSettings', { summary: 'The head’s settings: id, display name, timezone', ok: ok(S.Settings), errors: [400, 401] }),
    patch: operation('updateSettings', {
      summary: 'Set or clear the display name and the timezone override',
      body: S.SettingsPatch,
      ok: ok(S.Settings),
      errors: [400, 401, 413],
    }),
  },
  '/api/me/brief': {
    get: operation('getBrief', { summary: 'Everything the Brief screen shows, in one call', ok: ok(S.Brief), errors: [400, 401] }),
  },
  '/api/me/visit': {
    post: operation('postVisit', {
      summary: 'The owner left the brief: advance the last-visit cursor',
      body: S.VisitRequest,
      ok: ok(S.Visit),
      errors: [400, 401, 413],
    }),
  },
  '/api/me/cards': {
    get: operation('listCards', {
      summary: 'Cards received in a local day, a run of local days, or between two instants',
      description:
        'Ordered by `change_seq`, paginated with `after` and `next`. With `from`/`to`, `before` names the latest earlier ' +
        'day that has a card, so a client can page back through the timeline without fetching empty weeks.',
      parameters: [
        { name: 'date', in: 'query', description: 'A local day, YYYY-MM-DD, in the effective timezone', schema: { type: 'string' } },
        { name: 'from', in: 'query', description: 'First local day, YYYY-MM-DD, inclusive; with `to`, not with `date`', schema: { type: 'string' } },
        { name: 'to', in: 'query', description: 'Last local day, YYYY-MM-DD, inclusive', schema: { type: 'string' } },
        { name: 'since', in: 'query', description: 'Received at or after, RFC 3339', schema: { type: 'string' } },
        { name: 'until', in: 'query', description: 'Received before, RFC 3339', schema: { type: 'string' } },
        { name: 'state', in: 'query', schema: { type: 'string', enum: ['open', 'decided', 'superseded'] } },
        { name: 'after', in: 'query', description: 'The `next` of the previous page', schema: { type: 'integer', minimum: 0 } },
        { name: 'limit', in: 'query', description: '1–200, default 50', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      ],
      ok: ok(S.CardList),
      errors: [400, 401],
    }),
  },
  '/api/me/cards/{id}': {
    get: operation('getCard', { summary: 'One card with its supersession chain, references and thread', parameters: [CARD_ID], ok: ok(S.CardDetail), errors: [400, 401, 404] }),
  },
  '/api/me/cards/{id}/decision': {
    post: operation('decide', {
      summary: 'Decide (RFC §7.3)',
      description: 'Deciding an order `dismissed` cancels it (A.5).',
      parameters: [CARD_ID],
      body: S.DecisionRequest,
      ok: cardResult,
      errors: [400, 401, 404, 409, 413],
    }),
  },
  '/api/me/cards/{id}/seen': {
    post: operation('markSeen', { summary: 'The card was shown to the owner (§4.2 `seen_at`)', parameters: [CARD_ID], ok: cardResult, errors: [400, 401, 404] }),
  },
  '/api/me/cards/{id}/ack': {
    post: operation('acknowledge', { summary: 'Acknowledge an artifact or signal (§4.2 `acknowledged_at`)', parameters: [CARD_ID], ok: cardResult, errors: [400, 401, 404] }),
  },
  '/api/me/cards/{id}/snooze': {
    post: operation('snooze', {
      summary: 'Hide an open card until a time (§4.2 `snoozed_until`)',
      description:
        '`until` must be an RFC 3339 timestamp in UTC (ending `Z` or `+00:00`) and later than now; anything else is ' +
        '400 `invalid_snooze`. A preset is resolved in the effective timezone. `until: null` unsnoozes.',
      parameters: [CARD_ID],
      body: S.SnoozeRequest,
      ok: cardResult,
      errors: [400, 401, 404, 409, 413],
    }),
  },
  '/api/me/cards/{id}/unsnooze': {
    post: operation('unsnooze', { summary: 'Clear `snoozed_until`', parameters: [CARD_ID], ok: cardResult, errors: [400, 401, 404, 409] }),
  },
  '/api/me/orders': {
    get: operation('listOrders', { summary: 'Active orders and those finished this week, with their progress', ok: ok(S.OrderList), errors: [400, 401] }),
    post: operation('giveOrder', { summary: 'Give an order (A.1)', body: S.OrderRequest, ok: ok(S.MeCard, 'The order', 201), errors: [400, 401, 413] }),
  },
  '/api/me/producers': {
    get: operation('listProducers', { summary: 'Producers by namespace root', ok: ok(S.ProducerList), errors: [400, 401] }),
  },
  '/api/me/producers/{root}': {
    patch: operation('updateProducer', {
      summary: 'Set a producer’s ceiling, or revoke it',
      parameters: [idParam('root', 'A producer’s namespace root')],
      body: S.ProducerPatch,
      ok: ok(S.Producer),
      errors: [400, 401, 404, 413],
    }),
  },
  '/api/me/devices': {
    get: operation('listDevices', { summary: 'The signed-in devices', ok: ok(S.DeviceList), errors: [400, 401] }),
  },
  '/api/me/devices/{id}': {
    delete: operation('deleteDevice', { summary: 'Sign a device out', parameters: [idParam('id', 'A device id')], ok: { 204: { description: 'Signed out' } }, errors: [400, 401, 404] }),
  },
  '/api/me/svg/{hash}': {
    get: operation('getDiagram', {
      summary: 'A drawn diagram',
      description: 'Linked from `rendered_html` and `first_visual`. No session: an image view cannot send one. Immutable; cache by URL.',
      parameters: [idParam('hash', 'sha256 of the sanitised fence, 64 hex digits')],
      ok: { 200: { description: 'The SVG', content: { 'image/svg+xml': { schema: { type: 'string' } } } } },
      errors: [404],
      public: true,
    }),
  },
  '/api/me/img': {
    get: operation('getImage', {
      summary: 'A remote image, through the head’s proxy',
      description: 'Linked from `rendered_html`; the URL is signed by the head. No session. At most 2 MB, image types only.',
      parameters: [
        { name: 'u', in: 'query', required: true, description: 'The image URL', schema: { type: 'string' } },
        { name: 's', in: 'query', required: true, description: 'The head’s signature of `u`', schema: { type: 'string' } },
      ],
      ok: { 200: { description: 'The image', content: { 'image/*': { schema: { type: 'string', contentMediaType: 'image/*' } } } } },
      errors: [403, 502],
      public: true,
    }),
  },
};

/** Zod's JSON Schema for one registry, as OpenAPI components: without `$schema`/`$id`, and without the safe-integer bounds it adds to every integer. */
function components(registry: typeof S.responses, io: 'input' | 'output'): Json {
  const { schemas } = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}`, io, unrepresentable: 'any' }) as { schemas: Record<string, Json> };
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (!v || typeof v !== 'object') return v;
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '$schema' || k === '$id') continue;
      if ((k === 'minimum' && x === Number.MIN_SAFE_INTEGER) || (k === 'maximum' && x === Number.MAX_SAFE_INTEGER)) continue;
      out[k] = clean(x);
    }
    return out;
  };
  return clean(schemas) as Json;
}

export function openApiDocument(version: string): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PBCP head: the human API',
      version,
      description:
        'What the owner’s devices call: the brief, cards, decisions, orders, settings. Producers use the PBCP ' +
        'protocol routes instead (RFC §7), which this document does not cover; sign-in (/api/auth/*) is not in ' +
        'it either. Every /api/me request needs `Authorization: Session <access token>` and may carry `X-Timezone`.',
    },
    servers: [{ url: '/' }],
    security: [{ session: [] }],
    paths: PATHS,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'header', name: 'Authorization', description: '`Session <access token>`, from sign-in or /api/auth/refresh. A producer’s `Bearer` token is refused with 401.' },
      },
      parameters: {
        XTimezone: { name: 'X-Timezone', in: 'header', required: false, description: TIMEZONE_DESCRIPTION, schema: { type: 'string' } },
      },
      schemas: { ...components(S.responses, 'output'), ...components(S.requests, 'input') },
    },
  };
}
