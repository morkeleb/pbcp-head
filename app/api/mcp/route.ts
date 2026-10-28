// /api/mcp — the owner's MCP server (packages/owner-mcp) over streamable HTTP, for an assistant acting for the owner.
//
// It is authenticated by `Authorization: Bearer <access token>`, and that Bearer is a *session*, not a producer token:
// an access token this head's authorization server issued (lib/oauth.ts) to an assistant's device, with scope `owner`,
// for this URL. RFC 6750 and the MCP authorization spec name the scheme Bearer; the credential is the owner's. Two
// credential types, never mixed, still holds: a producer token is refused here (401), and this access token is refused
// on every producer route (they look tokens up in producer_tokens, where it is not).
//
// Stateless: each request gets its own server and transport, and JSON responses. The tools call the owner's API
// (/api/me) with the same access token, as any other owner client does.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createOwnerServer } from '@pbcp-head/owner-mcp';
import { db } from '../../../db/client';
import { preflight, withCors } from '../../../lib/cors';
import { authenticateAssistant, presentedToken, unauthorized, oauthOrigin } from '../../../lib/oauth';

export const dynamic = 'force-dynamic';

async function serve(req: Request): Promise<Response> {
  const origin = oauthOrigin();
  if (!(await authenticateAssistant(db(), req, origin))) return withCors(unauthorized(origin));
  const token = presentedToken(req)!;
  const server = createOwnerServer({ headUrl: origin, accessToken: async () => token });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(req));
  } finally {
    void server.close();
  }
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
export const OPTIONS = preflight;
