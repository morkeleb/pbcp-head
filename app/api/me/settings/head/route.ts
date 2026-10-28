// GET /api/me/settings/head — this head as a producer sees it: owner id, the head URL, protocol, extensions and mermaid
// tiers (RFC §7.5).

import { db } from '../../../../../db/client';
import { json } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { headFacts, headOrigin, producerUrl } from '../../../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s, req) => json(await headFacts(db(), s.headId, producerUrl(headOrigin(req.url)))));
