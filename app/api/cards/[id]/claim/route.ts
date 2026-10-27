// POST /api/cards/{id}/claim { lease_seconds } — claim or renew an order's lease (RFC A.2, A.5). Producer token only.

import { db } from '../../../../../db/client';
import { authenticateProducer } from '../../../../../lib/auth/producer';
import { handle, json, rawSegment, readJson } from '../../../../../lib/http';
import { claimOrder } from '../../../../../lib/orders';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const producer = await authenticateProducer(db(), req);
    const r = await claimOrder(db(), producer, rawSegment(req, 3), await readJson(req));
    return json(r.card, r.status);
  });
}
