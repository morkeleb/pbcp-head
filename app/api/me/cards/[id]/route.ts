// GET /api/me/cards/{id} — one card, rendered, with its thread: predecessors, successors, references.

import { db } from '../../../../../db/client';
import { decodeId, json, rawSegment } from '../../../../../lib/http';
import { cardWithThread } from '../../../../../lib/me';
import { meHandler } from '../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s, req) => json(await cardWithThread(db(), s.headId, decodeId(rawSegment(req, 4)))));
