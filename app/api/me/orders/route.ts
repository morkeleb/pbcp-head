// GET /api/me/orders — active orders and those finished this week, each with its progress (A.3 thread).
// POST /api/me/orders { to_producer, title, body, urgency? } — the owner gives an order (A.1); 201 with the order.
// Cancelling is the decision `dismissed` on the order, through POST /api/me/cards/{id}/decision.

import { after } from 'next/server';
import { db } from '../../../../db/client';
import { OrderRequest, parseRequest } from '../../../../lib/api/schemas';
import { json, readObject } from '../../../../lib/http';
import { headSettings, orderProgress, presentCards, rowsFor } from '../../../../lib/me';
import { giveOrder, ordersFor } from '../../../../lib/orders';
import { meHandler } from '../../../../lib/owner';
import { renderAfterCommit } from '../../../../lib/render';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => {
  const orders = await ordersFor(db(), s.headId);
  const { timezone } = await headSettings(db(), s.headId);
  return json({ timezone, orders: await orderProgress(db(), s.headId, orders) });
});

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const POST = meHandler({ assistant: true }, async (s, req) => {
  const b = parseRequest(OrderRequest, await readObject(req));
  const order = await giveOrder(db(), s.headId, { to_producer: b.to_producer, title: b.title.trim(), body: b.body ?? '', ...(b.urgency ? { urgency: b.urgency } : {}) });
  after(() => renderAfterCommit(db(), s.headId, order));
  const [shown] = await presentCards(db(), await rowsFor(db(), s.headId, [order.id]));
  return json(shown, 201);
});
