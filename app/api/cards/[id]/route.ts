// PUT /api/cards/{id} — submit (RFC §7.1). Producer token only.

import { after } from 'next/server';
import { db } from '../../../../db/client';
import { authenticateProducer } from '../../../../lib/auth/producer';
import { handle, json, rawSegment, readBody } from '../../../../lib/http';
import { submitCard } from '../../../../lib/protocol';
import { notifyUrgent } from '../../../../lib/push/urgent';
import { producerKey, rateLimit } from '../../../../lib/rate-limit';
import { renderAfterCommit } from '../../../../lib/render';

export const dynamic = 'force-dynamic';

export function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    // §7.1 order: 401, then 429, then 413 (before reading the body: readBody), then the card.
    const producer = await authenticateProducer(db(), req);
    await rateLimit(db(), 'put', producerKey(req));
    const r = await submitCard(db(), producer, await readBody(req), rawSegment(req, 3));
    // §3.1: render on receipt, after the commit and off the producer's response path.
    if (r.status !== 409) after(() => renderAfterCommit(db(), producer.headId, r.card));
    // An immediate card is a push to the owner's devices with "Urgent cards" on: after the commit, best effort, never
    // the PUT's failure (lib/push/urgent.ts).
    if (r.status !== 409) after(() => notifyUrgent(db(), producer.headId, r.card, r.previous ?? null));
    return json(r.card, r.status);
  });
}
