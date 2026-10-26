// The owner-side card actions, shared by `POST /api/cards/{id}/decision` (§7.3) and `/api/me/cards/{id}/…`.
// Session only: the person acts through a signed-in device, and that device is the decision's actor.
// `idSegment` is where `{id}` sits in the route's path.

import { db } from '../db/client';
import { authenticateSession } from './auth/session';
import { decodeId, handle, json, rawSegment, readJson } from './http';
import { acknowledgeCard, decideCard, markCardSeen, type OwnerContext, type Outcome } from './protocol';

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
