// GET /api/me/brief — one call paints the Brief screen (mobile PRD, Human API).

import { db } from '../../../../db/client';
import { json } from '../../../../lib/http';
import { brief } from '../../../../lib/me';
import { meHandler } from '../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
export const GET = meHandler({ assistant: true }, async (s) => json(await brief(db(), s.headId)));
