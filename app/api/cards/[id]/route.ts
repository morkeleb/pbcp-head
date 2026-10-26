// PUT /api/cards/{id} — submit (RFC §7.1). Producer token only.

import { PbcpError } from '@pbcp/core';
import { db } from '../../../../db/client';
import { authenticateProducer } from '../../../../lib/auth/producer';
import { handle, json, rawSegment } from '../../../../lib/http';
import { submitCard } from '../../../../lib/protocol';

export const dynamic = 'force-dynamic';

/** Refuse before reading a body this large; the 64 KiB card limit itself is checked on the card (§3.1). */
const MAX_REQUEST_BYTES = 1024 * 1024;

export function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const producer = await authenticateProducer(db(), req);
    if (Number(req.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) throw new PbcpError('too_large', 'request body too large');
    const r = await submitCard(db(), producer, await req.text(), rawSegment(req, 3));
    return json(r.card, r.status);
  });
}
