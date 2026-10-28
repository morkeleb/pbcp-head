// GET /api/me/seq — whether the brief has changed, cheaply: the head's change counter (every card stored, every
// decision) and its local date. The web app asks this when it returns to the foreground, once a minute while the brief
// is on screen, and when a push arrives, and loads the brief again only when either has moved.

import { db } from '../../../../db/client';
import { json } from '../../../../lib/http';
import { briefStamp } from '../../../../lib/me';
import { meHandler } from '../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json(await briefStamp(db(), s.headId)));
