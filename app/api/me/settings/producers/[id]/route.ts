// PATCH /api/me/settings/producers/{id} { ceiling?, name? } — the ceiling of that token's producer (RFC §9: per producer,
// so every live token of its root), and its display name (1–60 characters; the root never changes). Addressed by token
// id, not root: a root can hold one token per instance. DELETE — revokes that token: its producer gets 401 from then on
// (§12). The owner's session only: an assistant's scoped token is refused (lib/auth/session.ts).

import { db } from '../../../../../../db/client';
import { parseRequest, TokenPatch } from '../../../../../../lib/api/schemas';
import { HttpError, json, rawSegment, readObject } from '../../../../../../lib/http';
import { meHandler } from '../../../../../../lib/owner';
import { listTokens, renameToken, revokeToken } from '../../../../../../lib/settings/producers';
import { updateProducer } from '../../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const PATCH = meHandler(async (s, req) => {
  const id = rawSegment(req, 5);
  const token = (await listTokens(db(), s.headId)).find((t) => t.id === id);
  if (!token) throw new HttpError(404, 'not_found', `no live producer token ${id}`);
  const patch = parseRequest(TokenPatch, await readObject(req));
  // The name first: a bad one refuses the whole request before the ceiling changes.
  if (patch.name !== undefined) await renameToken(db(), s.headId, id, patch.name);
  if (patch.ceiling !== undefined) await updateProducer(db(), s.headId, token.root, { ceiling: patch.ceiling });
  return json((await listTokens(db(), s.headId)).find((t) => t.id === id));
});

export const DELETE = meHandler(async (s, req) => {
  await revokeToken(db(), s.headId, rawSegment(req, 5));
  return new Response(null, { status: 204 });
});
