// pbcp-owner-mcp: the owner's MCP server over stdio, for a desktop client (Claude Desktop, any MCP client).
//
//   pbcp-owner-mcp login https://head.example   sign in once: OAuth with PKCE through a loopback redirect; prints
//                                                PBCP_SESSION
//   pbcp-owner-mcp                               serve, with PBCP_HEAD_URL and PBCP_SESSION in the environment
//
// PBCP_SESSION is `<client id>:<refresh token>`, an assistant's credential from the head's authorization server, never a
// producer token (one is refused: two credential types, never mixed). Refresh tokens rotate on every use, so the
// newest is kept in a state file (0600) beside the user's config and used in preference to the one in the environment.

import { discoverAuthorizationServerMetadata, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createOwnerServer } from './index';
import { formatSession, parseSession, type Credential } from './stdio-session';

const SCOPE = 'owner';


const origin = (url: string) => new URL(url).origin;
const mcp = (head: string) => `${origin(head)}/api/mcp`;

function stateFile(head: string): string {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pbcp-owner-mcp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${new URL(head).host.replace(/[^A-Za-z0-9.-]/g, '_')}.json`);
}

function saved(head: string, clientId: string): string | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(head), 'utf8')) as Partial<Credential>;
    return s.clientId === clientId && typeof s.refreshToken === 'string' ? s.refreshToken : null;
  } catch {
    return null;
  }
}

const save = (head: string, c: Credential) => writeFileSync(stateFile(head), JSON.stringify(c), { mode: 0o600 });

async function metadata(head: string): Promise<AuthorizationServerMetadata> {
  const m = await discoverAuthorizationServerMetadata(origin(head));
  if (!m) throw new Error(`${origin(head)} publishes no OAuth metadata (/.well-known/oauth-authorization-server)`);
  return m;
}

/** Access tokens for the owner, refreshed (and their refresh token rotated and saved) a minute before they expire. */
export function accessTokens(head: string, seed: Credential): () => Promise<string> {
  let refreshToken = saved(head, seed.clientId) ?? seed.refreshToken;
  let current: { token: string; until: number } | null = null;
  let meta: AuthorizationServerMetadata | null = null;
  return async () => {
    if (current && Date.now() < current.until) return current.token;
    meta ??= await metadata(head);
    const t = await refreshAuthorization(origin(head), { metadata: meta, clientInformation: { client_id: seed.clientId }, refreshToken, resource: mcp(head) });
    refreshToken = t.refresh_token ?? refreshToken;
    save(head, { clientId: seed.clientId, refreshToken });
    current = { token: t.access_token, until: Date.now() + ((t.expires_in ?? 900) - 60) * 1000 };
    return current.token;
  };
}

/** Signs in once: registers this client, opens the consent page, and catches the code on a loopback address (RFC 8252). */
async function login(head: string): Promise<void> {
  const meta = await metadata(head);
  const state = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const client = await registerClient(origin(head), { metadata: meta, clientMetadata: { client_name: 'Claude Desktop (pbcp-owner-mcp)', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE } });
  const { authorizationUrl, codeVerifier } = await startAuthorization(origin(head), { metadata: meta, clientInformation: client, redirectUrl: redirectUri, scope: SCOPE, state, resource: mcp(head) });
  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/callback') return void res.writeHead(404).end();
      const done = (text: string) => res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
      if (u.searchParams.get('state') !== state) return void (done('This sign-in did not come from this login. Close this tab and run it again.'), reject(new Error('state did not match')));
      const err = u.searchParams.get('error');
      if (err) return void (done('Not allowed. You can close this tab.'), reject(new Error(`${err}: ${u.searchParams.get('error_description') ?? ''}`)));
      done('Signed in. You can close this tab and return to the terminal.');
      resolve(u.searchParams.get('code') ?? '');
    });
    console.error(`Open this to allow it, signed in to your head:\n\n  ${authorizationUrl.href}\n`);
    execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [authorizationUrl.href], () => undefined);
  });
  server.close();
  const t = await exchangeAuthorization(origin(head), { metadata: meta, clientInformation: client, authorizationCode: code, codeVerifier, redirectUri, resource: mcp(head) });
  const credential = { clientId: client.client_id, refreshToken: t.refresh_token! };
  save(head, credential);
  console.log(`PBCP_HEAD_URL=${origin(head)}\nPBCP_SESSION=${formatSession(credential)}`);
}

async function serve(): Promise<void> {
  const head = process.env.PBCP_HEAD_URL;
  if (!head) throw new Error('PBCP_HEAD_URL is not set');
  const seed = parseSession(process.env.PBCP_SESSION);
  const server = createOwnerServer({ headUrl: origin(head), accessToken: accessTokens(head, seed) });
  await server.connect(new StdioServerTransport());
}

const [command, arg] = process.argv.slice(2);
(command === 'login' ? (arg ? login(arg) : Promise.reject(new Error('usage: pbcp-owner-mcp login <head url>'))) : serve()).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
