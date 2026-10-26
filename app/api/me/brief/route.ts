// GET /api/me/brief — one call paints the Brief screen (mobile PRD, Human API).

import { db } from '../../../../db/client';
import { json } from '../../../../lib/http';
import { brief } from '../../../../lib/me';
import { meHandler } from '../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json(await brief(db(), s.headId)));
