// The owner-side card actions, shared by `POST /api/cards/{id}/decision` (§7.3) and `/api/me/cards/{id}/…`.
// Session only: the person acts through a signed-in device, and that device is the decision's actor.
// `idSegment` is where `{id}` sits in the route's path.

import { db } from '../db/client';
import { authenticateSession, type Session } from './auth/session';
import { decodeId, handle, json, rawSegment, readJson, readObject } from './http';
import { acknowledgeCard, decideCard, markCardSeen, snoozeCard, unsnoozeCard, type OwnerContext, type Outcome } from './protocol';
import { snoozeUntil } from './settings-me';

function ownerAction(idSegment: number, act: (ctx: OwnerContext, id: string, req: Request) => Promise<Outcome>) {
  return (req: Request): Promise<Response> =>
    handle(async () => {
      const session = await authenticateSession(db(), req);
      const r = await act({ headId: session.headId, actor: session.deviceId }, decodeId(rawSegment(req, idSegment)), req);
      return json(r.card, r.status);
    });
}

export const decisionHandler = (idSegment: number) =>
  ownerAction(idSegment, async (ctx, id, req) => decideCard(db(), ctx, id, await readJson(req)));

export const seenHandler = (idSegment: number) => ownerAction(idSegment, (ctx, id) => markCardSeen(db(), ctx, id));

export const acknowledgeHandler = (idSegment: number) => ownerAction(idSegment, (ctx, id) => acknowledgeCard(db(), ctx, id));

/** Any other /api/me route: a session, then `fn` with it. */
export function meHandler(fn: (session: Session, req: Request) => Promise<Response>) {
  return (req: Request): Promise<Response> =>
    handle(async () => fn(await authenticateSession(db(), req), req));
}

/** POST /api/me/cards/{id}/snooze { until } | { preset }; `until: null` unsnoozes. */
export const snoozeHandler = (idSegment: number) =>
  ownerAction(idSegment, async (ctx, id, req) => {
    const until = await snoozeUntil(db(), ctx.headId, await readObject(req));
    return until === null ? unsnoozeCard(db(), ctx, id) : snoozeCard(db(), ctx, id, until);
  });

/** POST /api/me/cards/{id}/unsnooze. */
export const unsnoozeHandler = (idSegment: number) => ownerAction(idSegment, (ctx, id) => unsnoozeCard(db(), ctx, id));
