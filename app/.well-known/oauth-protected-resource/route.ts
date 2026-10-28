// GET /.well-known/oauth-protected-resource — the protected resource's metadata (RFC 9728) for /api/mcp: where its authorization
// server is (lib/oauth.ts).

import { preflight, withCors } from '../../../lib/cors';
import { protectedResourceMetadata, oauthOrigin } from '../../../lib/oauth';

export const dynamic = 'force-dynamic';

export const GET = () => withCors(Response.json(protectedResourceMetadata(oauthOrigin())));
export const OPTIONS = preflight;
