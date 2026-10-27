// HeadUnderTest (from @pbcp/core/conformance) over HTTP, against a running head in test mode.
//
//   reset       truncate every table, recreate head `morten`, sign in one owner device, reset the test hooks
//   token       mint a producer token for the root, as `pnpm mint-token` does; a further token for the same
//               root is a further instance of it (C35)
//   describe    GET /                          Bearer, or none
//   put         PUT /api/cards/{id}            Bearer   (JSON, or text/markdown for the file form)
//   changes     GET /api/changes?after=        Bearer   (`after` sent as given, so malformed cursors reach the head)
//   decide      POST /api/me/cards/{id}/decision  Session
//   decideWithToken  POST /api/cards/{id}/decision with the producer's Bearer token (§7.3: must be 401)
//   order       POST /api/me/orders            Session  (the owner gives an order; A.1)
//   claim       POST /api/cards/{id}/claim     Bearer   { lease_seconds } (A.2)
//   seen        POST /api/me/cards/{id}/seen      Session
//   acknowledge POST /api/me/cards/{id}/ack       Session
//   snooze      POST /api/me/cards/{id}/snooze    Session  { until }; null unsnoozes, via /unsnooze
//   clock.set   POST /api/test { clock }; the runner awaits it before the next step

import type { Decision } from '@pbcp/core';
import type { HeadUnderTest, Response } from '@pbcp/core/conformance';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { mintProducerToken } from '../../lib/auth/producer';
import { startSession } from '../../lib/auth/session';
import { ensureHead } from '../../lib/heads';

export interface HttpHeadOptions {
  baseUrl: string;
  /** Direct access to the head's database, for reset and token minting. */
  db: Db;
  owner?: string;
  /** Sync page cap for the run; the head's own is 200. */
  pageSize?: number;
  /** Where the clock starts after reset; the in-process adapter starts here too. */
  startClock?: string;
}

export function httpHead(opts: HttpHeadOptions): HeadUnderTest {
  const owner = opts.owner ?? 'morten';
  let session = '';
  /** Tokens minted per root since the last reset. */
  const minted = new Map<string, number>();

  async function request(method: string, path: string, auth: string | null, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = auth === null ? {} : { authorization: auth };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      headers['content-type'] = typeof body === 'string' ? 'text/markdown' : 'application/json';
    }
    const res = await fetch(`${opts.baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON; the fixture will say so
    }
    return { status: res.status, body: parsed };
  }

  async function hooks(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${opts.baseUrl}/api/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`the head under test refused /api/test (${res.status}); is it running with PBCP_TEST_MODE=1?`);
  }

  const card = (id: string) => `/api/me/cards/${encodeURIComponent(id)}`;

  return {
    async reset() {
      await opts.db.execute(sql`truncate decision_log, devices, identities, cards, producer_tokens, change_counter, heads restart identity`);
      await ensureHead(opts.db, owner);
      session = `Session ${(await startSession(opts.db, { headId: owner, identityId: null, platform: 'web', name: 'conformance' })).access_token}`;
      minted.clear();
      await hooks({ clock: opts.startClock ?? '2026-10-07T00:00:00Z', syncPageSize: opts.pageSize ?? null });
    },

    /**
     * The runner asks for one token per root, ceiling, executor flag and `instance` (C35: two installations of
     * one producer). The interface does not pass the instance, so every further token for a root is minted as a
     * further instance of it, a distinct principal under the same root, as `pnpm mint-token --instance` does.
     * No ceiling is the head's default, `brief` (§9).
     */
    async token(root, o) {
      const n = (minted.get(root) ?? 0) + 1;
      minted.set(root, n);
      return mintProducerToken(opts.db, {
        headId: owner, root, ...(n > 1 ? { instance: `instance-${n}` } : {}), ...(o?.executor ? { executor: true } : {}), ...(o?.ceiling ? { ceiling: o.ceiling } : {}),
      });
    },

    async describe(token) {
      return request('GET', '/', bearer(token));
    },

    async put(token, input) {
      return request('PUT', `/api/cards/${encodeURIComponent(urlId(input))}`, bearer(token), input);
    },

    async changes(token, after) {
      return request('GET', `/api/changes?after=${encodeURIComponent(String(after))}`, bearer(token));
    },

    async order(input) {
      return request('POST', '/api/me/orders', session, input);
    },

    async claim(token, id, lease) {
      return request('POST', `/api/cards/${encodeURIComponent(id)}/claim`, `Bearer ${token}`, { lease_seconds: lease });
    },

    async decideWithToken(token, id, d: Decision) {
      return request('POST', `/api/cards/${encodeURIComponent(id)}/decision`, `Bearer ${token}`, d);
    },

    async decide(id, d: Decision) {
      return request('POST', `${card(id)}/decision`, session, d);
    },

    async seen(id) {
      return request('POST', `${card(id)}/seen`, session);
    },

    async acknowledge(id) {
      return request('POST', `${card(id)}/ack`, session);
    },

    async snooze(id, until) {
      return until === null ? request('POST', `${card(id)}/unsnooze`, session) : request('POST', `${card(id)}/snooze`, session, { until });
    },

    clock: {
      set: (iso) => hooks({ clock: iso }),
    },
  };
}

const bearer = (token: string | null) => (token === null ? null : `Bearer ${token}`);

/**
 * The id to put in the URL. The fixtures hand the adapter a card, not a URL, so the adapter names the id the
 * card claims; for a card too broken to have one, any id will do, since the card is refused as a 400 before
 * the URL is compared (§7.1 lists id_mismatch among the 400s).
 */
function urlId(input: unknown): string {
  if (typeof input === 'string') {
    const m = /^id:[ \t]*(.*?)[ \t]*$/m.exec(input);
    const raw = m?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
    return raw || 'unknown:unknown:unknown';
  }
  const id = (input as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id !== '' ? id : 'unknown:unknown:unknown';
}
