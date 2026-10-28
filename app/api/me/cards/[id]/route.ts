// GET /api/me/cards/{id} — one card, rendered, with its thread: predecessors, successors, references.

import { db } from '../../../../../db/client';
import { decodeId, json, rawSegment } from '../../../../../lib/http';
import { cardWithThread } from '../../../../../lib/me';
import { meHandler } from '../../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const GET = meHandler({ assistant: true }, async (s, req) => json(await cardWithThread(db(), s.headId, decodeId(rawSegment(req, 4)))));
