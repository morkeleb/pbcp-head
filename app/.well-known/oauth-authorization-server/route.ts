// GET /.well-known/oauth-authorization-server — the authorization server's metadata (RFC 8414; lib/oauth.ts).

import { preflight, withCors } from '../../../lib/cors';
import { authorizationServerMetadata, oauthOrigin } from '../../../lib/oauth';

export const dynamic = 'force-dynamic';

export const GET = () => withCors(Response.json(authorizationServerMetadata(oauthOrigin())));
export const OPTIONS = preflight;
