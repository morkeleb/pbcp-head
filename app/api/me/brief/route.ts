// GET /api/me/brief — one call paints the Brief screen (mobile PRD, Human API).

import { db } from '../../../../db/client';
import { json } from '../../../../lib/http';
import { brief } from '../../../../lib/me';
import { meHandler } from '../../../../lib/owner';

export const dynamic = 'force-dynamic';

// An assistant's tools call this route (packages/owner-mcp): its scoped token is accepted here (lib/auth/session.ts).
// `?spoken=1`: the daily paragraph in plain text with private entries counted, not named (RFC 0.9 §4.1), for a surface
// outside the signed-in session (lib/me.ts BriefOptions).
export const GET = meHandler({ assistant: true }, async (s, req) => {
  const spoken = new URL(req.url).searchParams.get('spoken');
  return json(await brief(db(), s.headId, { spoken: spoken === '1' || spoken === 'true' }));
});
