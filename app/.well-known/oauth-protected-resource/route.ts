// GET /.well-known/oauth-protected-resource — the protected resource's metadata (RFC 9728) for /api/mcp: where its authorization
// server is (lib/oauth.ts).

import { preflight, withCors } from '../../../lib/cors';
import { protectedResourceMetadata } from '../../../lib/oauth';
import { headOrigin } from '../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => withCors(Response.json(protectedResourceMetadata(headOrigin(req.url))));
export const OPTIONS = preflight;
