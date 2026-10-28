// PATCH /api/me/settings/producers/{id} { ceiling } — the ceiling of that token's producer (RFC §9: per producer, so
// every live token of its root). DELETE — revokes that token: its producer gets 401 from then on (§12).

import { db } from '../../../../../../db/client';
import { parseRequest, TokenPatch } from '../../../../../../lib/api/schemas';
import { HttpError, json, rawSegment, readObject } from '../../../../../../lib/http';
import { meHandler } from '../../../../../../lib/owner';
import { listTokens, revokeToken } from '../../../../../../lib/settings/producers';
import { updateProducer } from '../../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const PATCH = meHandler(async (s, req) => {
  const id = rawSegment(req, 5);
  const token = (await listTokens(db(), s.headId)).find((t) => t.id === id);
  if (!token) throw new HttpError(404, 'not_found', `no live producer token ${id}`);
  await updateProducer(db(), s.headId, token.root, parseRequest(TokenPatch, await readObject(req)));
  return json((await listTokens(db(), s.headId)).find((t) => t.id === id));
});

export const DELETE = meHandler(async (s, req) => {
  await revokeToken(db(), s.headId, rawSegment(req, 5));
  return new Response(null, { status: 204 });
});
