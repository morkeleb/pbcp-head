// Cross-origin access for what an MCP client in a browser must reach: the OAuth metadata, registration and token
// endpoints, and /api/mcp. Safe to open to any origin: nothing here uses cookies or ambient credentials; every call
// carries its own (a PKCE verifier, a refresh token, a Bearer access token).

export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '600',
};

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS });
