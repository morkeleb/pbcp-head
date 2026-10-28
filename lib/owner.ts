// The owner-side card actions, shared by `POST /api/cards/{id}/decision` (§7.3) and `/api/me/cards/{id}/…`.
// Session only: the person acts through a signed-in device, and that device is the decision's actor.
// `idSegment` is where `{id}` sits in the route's path.

import { db } from '../db/client';
import { authenticateSession, type Session, type SessionPolicy } from './auth/session';
import { decodeId, handle, json, rawSegment, readJson, readObject } from './http';
import { acknowledgeCard, decideCard, markCardSeen, snoozeCard, unsnoozeCard, type OwnerContext, type Outcome } from './protocol';
import { snoozeUntil } from './settings-me';

function ownerAction(idSegment: number, act: (ctx: OwnerContext, id: string, req: Request) => Promise<Outcome>, policy: SessionPolicy = {}) {
  return (req: Request): Promise<Response> =>
    handle(async () => {
      const session = await authenticateSession(db(), req, policy);
      const r = await act({ headId: session.headId, actor: session.deviceId }, decodeId(rawSegment(req, idSegment)), req);
      return json(r.card, r.status);
    });
}

// `policy`: `{ assistant: true }` on exactly the routes packages/owner-mcp's tools call (lib/auth/session.ts).
export const decisionHandler = (idSegment: number, policy?: SessionPolicy) =>
  ownerAction(idSegment, async (ctx, id, req) => decideCard(db(), ctx, id, await readJson(req)), policy);

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
  return (req: Request): Promise<Response> => handle(async () => fn(await authenticateSession(db(), req, policy), req));
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
