// GET /.well-known/oauth-authorization-server — the authorization server's metadata (RFC 8414; lib/oauth.ts).

import { preflight, withCors } from '../../../lib/cors';
import { authorizationServerMetadata } from '../../../lib/oauth';
import { headOrigin } from '../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => withCors(Response.json(authorizationServerMetadata(headOrigin(req.url))));
export const OPTIONS = preflight;
