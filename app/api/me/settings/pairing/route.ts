// GET /api/me/settings/pairing — the head's pairing codes that can still be used (never the codes themselves).
// POST /api/me/settings/pairing — makes one (lib/settings/pairing.ts): 201 with the code, in this answer only, and the
// sentence to give the agent.

import { db } from '../../../../../db/client';
import { json } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { headOrigin, producerUrl } from '../../../../../lib/settings/head';
import { createPairingCode, listPairingCodes } from '../../../../../lib/settings/pairing';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json({ codes: await listPairingCodes(db(), s.headId) }));

export const POST = meHandler(async (s, req) => {
  const made = await createPairingCode(db(), s.headId);
  const api = producerUrl(headOrigin(req.url));
  return json({ ...made, api, say: `Pair with ${api}, code ${made.code}.` }, 201);
});
