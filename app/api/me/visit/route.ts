// POST /api/me/visit { seq? } — the owner left the brief; advances the global last-visit cursor.

import { db } from '../../../../db/client';
import { json, readObject } from '../../../../lib/http';
import { meHandler } from '../../../../lib/owner';
import { visit } from '../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const POST = meHandler(async (s, req) => json(await visit(db(), s.headId, (await readObject(req)).seq)));
