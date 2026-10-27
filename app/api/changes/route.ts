// GET /api/changes?after={change_seq} — sync (RFC §7.2). Producer token only; the caller sees its own namespace.

import { db } from '../../../db/client';
import { authenticateProducer } from '../../../lib/auth/producer';
import { handle, json } from '../../../lib/http';
import { parseAfter, syncChanges } from '../../../lib/protocol';
import { producerKey, rateLimit } from '../../../lib/rate-limit';
import { syncPageSize } from '../../../lib/settings';

export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const producer = await authenticateProducer(db(), req);
    await rateLimit(db(), 'changes', producerKey(req));
    const after = parseAfter(new URL(req.url).searchParams.get('after'));
    return json(await syncChanges(db(), producer, after, syncPageSize()));
  });
}
