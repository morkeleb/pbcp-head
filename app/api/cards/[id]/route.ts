// PUT /api/cards/{id} — submit (RFC §7.1). Producer token only.

import { PbcpError } from '@pbcp/core';
import { after } from 'next/server';
import { db } from '../../../../db/client';
import { authenticateProducer } from '../../../../lib/auth/producer';
import { handle, json, rawSegment } from '../../../../lib/http';
import { submitCard } from '../../../../lib/protocol';
import { renderAfterCommit } from '../../../../lib/render';

export const dynamic = 'force-dynamic';

/** Refuse before reading a body this large; the 64 KiB card limit itself is checked on the card (§3.1). */
const MAX_REQUEST_BYTES = 1024 * 1024;

export function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const producer = await authenticateProducer(db(), req);
    if (Number(req.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) throw new PbcpError('too_large', 'request body too large');
    const r = await submitCard(db(), producer, await req.text(), rawSegment(req, 3));
    // §3.1: render on receipt, after the commit and off the producer's response path.
    if (r.status !== 409) after(() => renderAfterCommit(db(), producer.headId, r.card));
    return json(r.card, r.status);
  });
}
