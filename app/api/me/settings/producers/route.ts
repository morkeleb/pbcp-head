// GET /api/me/settings/producers — the live producer tokens: root, created, last used, ceiling.
// POST /api/me/settings/producers { root, ceiling?, executor?, instance? } — mints a token (RFC §12). 201 with the token,
// which is never stored or shown again; 400 invalid_root, 409 root_in_use.

import { db } from '../../../../../db/client';
import { MintTokenRequest, parseRequest } from '../../../../../lib/api/schemas';
import { json, readObject } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { listTokens, mintToken } from '../../../../../lib/settings/producers';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json({ producers: await listTokens(db(), s.headId) }));

export const POST = meHandler(async (s, req) => json(await mintToken(db(), s.headId, parseRequest(MintTokenRequest, await readObject(req))), 201));
