// The owner-side card actions, shared by `POST /api/cards/{id}/decision` (§7.3) and `/api/me/cards/{id}/…`.
// Session only: the person acts through a signed-in device, and that device is the decision's actor.
// `idSegment` is where `{id}` sits in the route's path.

import { db } from '../db/client';
import { authenticateSession, MCP_PLATFORM, type Session, type SessionPolicy } from './auth/session';
import { decodeId, handle, json, rawSegment, readJson, readObject } from './http';
import { acknowledgeCard, decideCard, markCardSeen, snoozeCard, unsnoozeCard, type OwnerContext, type Outcome } from './protocol';
import { redactForAssistant } from './me';
import { snoozeUntil } from './settings-me';
import { replacedBy } from './store';

function ownerAction(idSegment: number, act: (ctx: OwnerContext, id: string, req: Request) => Promise<Outcome>, policy: SessionPolicy = {}) {
  return (req: Request): Promise<Response> =>
    handle(async () => {
      const session = await authenticateSession(db(), req, policy);
      const ctx: OwnerContext = {
        headId: session.headId,
        actor: session.deviceId,
        canIdentify: session.platform !== MCP_PLATFORM,
        reauthenticatedAt: session.reauthenticatedAt ?? null,
      };
      const r = await act(ctx, decodeId(rawSegment(req, idSegment)), req);
      // RFC 0.9 §4.1: an assistant never receives a private card's content, not even in an action's answer.
      return json(session.platform === MCP_PLATFORM ? await redactForAssistant(db(), session.headId, r.card) : r.card, r.status);
    });
}

// `policy`: `{ assistant: true }` on exactly the routes packages/owner-mcp's tools call (lib/auth/session.ts).
// `explain`: on the owner's API only, a 409 on a superseded card also names what replaced it and says so in words, so the
// interface can offer the successor instead of quietly showing the card unchanged (§8). The RFC route (§7.3) answers with
// the stored card and nothing else.
export const decisionHandler = (idSegment: number, policy?: SessionPolicy, { explain = false }: { explain?: boolean } = {}) =>
  ownerAction(
    idSegment,
    async (ctx, id, req) => {
      const r = await decideCard(db(), ctx, id, await readJson(req));
      if (!explain || r.status !== 409 || r.card.state !== 'superseded') return r;
      const replaced_by = await replacedBy(db(), ctx.headId, r.card);
      return replaced_by ? { ...r, card: { ...r.card, replaced_by, message: `This card was replaced by “${replaced_by.title}”.` } as typeof r.card } : r;
    },
    policy,
  );

export const seenHandler = (idSegment: number, policy?: SessionPolicy) => ownerAction(idSegment, (ctx, id) => markCardSeen(db(), ctx, id), policy);

export const acknowledgeHandler = (idSegment: number, policy?: SessionPolicy) => ownerAction(idSegment, (ctx, id) => acknowledgeCard(db(), ctx, id), policy);

type MeFn = (session: Session, req: Request) => Promise<Response>;

/**
 * Any other /api/me route: a session, then `fn` with it. The owner's own session only, unless `policy` opts the route in
 * for an assistant's scoped token: `meHandler({ assistant: true }, fn)`, for the routes the assistant's tools call.
 */
export function meHandler(fn: MeFn): (req: Request) => Promise<Response>;
export function meHandler(policy: SessionPolicy, fn: MeFn): (req: Request) => Promise<Response>;
export function meHandler(a: MeFn | SessionPolicy, b?: MeFn) {
  const [policy, fn] = typeof a === 'function' ? [{}, a] : [a, b!];
  return (req: Request): Promise<Response> =>
    handle(async () => {
      const session = await authenticateSession(db(), req, policy);
      const res = await fn(session, req);
      // RFC 0.9 §4.1, §12: the head strips every private and confirm card's content from what an assistant's scoped token
      // receives (lib/me.ts redactForAssistant), on every route the assistant reaches. The owner's own session is untouched.
      if (session.platform !== MCP_PLATFORM || !(res.headers.get('content-type') ?? '').includes('application/json')) return res;
      return json(await redactForAssistant(db(), session.headId, await res.json()), res.status);
    });
}

/** POST /api/me/cards/{id}/snooze { until } | { preset }; `until: null` unsnoozes. */
export const snoozeHandler = (idSegment: number, policy?: SessionPolicy) =>
  ownerAction(
    idSegment,
    async (ctx, id, req) => {
      const until = await snoozeUntil(db(), ctx.headId, await readObject(req));
      return until === null ? unsnoozeCard(db(), ctx, id) : snoozeCard(db(), ctx, id, until);
    },
    policy,
  );

/** POST /api/me/cards/{id}/unsnooze. */
export const unsnoozeHandler = (idSegment: number, policy?: SessionPolicy) => ownerAction(idSegment, (ctx, id) => unsnoozeCard(db(), ctx, id), policy);
