// GET /api/me/producers — producers by namespace root: ceiling, tokens, revoked, last card.

import { db } from '../../../../db/client';
import { json } from '../../../../lib/http';
import { listProducers } from '../../../../lib/me';
import { meHandler } from '../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json({ producers: await listProducers(db(), s.headId) }));
