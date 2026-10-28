// The owner's API (/api/me), typed from the head's OpenAPI document (packages/api-types/openapi.json → src/api.d.ts by
// `pnpm api-types`). This package knows the head only through that contract: no head internals.

import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './api';

export type Schemas = components['schemas'];
export type MeCard = Schemas['MeCard'];

export interface OwnerClientOptions {
  /** The head's origin, e.g. https://head.example (the owner's API is under /api/me). */
  headUrl: string;
  /** A current access token for the owner (a Session JWT); called before every request, so it can refresh. */
  accessToken: () => Promise<string>;
  /** For tests and for the head itself; the global fetch otherwise. */
  fetch?: typeof fetch;
}

/** A failed call: the head's status, its error code and message (RFC §7.4 shape), or the stored card on a 409. */
export class HeadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly card?: MeCard,
  ) {
    super(message);
  }
}

export type OwnerClient = ReturnType<typeof createOwnerClient>;

export function createOwnerClient(opts: OwnerClientOptions) {
  const auth: Middleware = {
    async onRequest({ request }) {
      // Two credential types, never mixed: the owner's API takes a Session, never a producer's Bearer.
      request.headers.set('authorization', `Session ${await opts.accessToken()}`);
      return request;
    },
  };
  const client = createClient<paths>({ baseUrl: opts.headUrl.replace(/\/+$/, ''), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  client.use(auth);
  return client;
}

/** The body of a successful call, or a HeadError with the head's own words. */
export function unwrap<T>(r: { data?: T; error?: unknown; response: Response }): T {
  if (r.response.ok && r.data !== undefined) return r.data;
  const e = (r.error ?? {}) as { error?: string; message?: string; id?: string; state?: string };
  if (r.response.status === 409 && typeof e.id === 'string') {
    throw new HeadError(409, 'not_open', `${e.id} is not open: it is ${e.state}`, e as unknown as MeCard);
  }
  throw new HeadError(r.response.status, e.error ?? 'error', e.message ?? `the head answered ${r.response.status}`);
}
