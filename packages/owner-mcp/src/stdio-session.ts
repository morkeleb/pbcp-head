// PBCP_SESSION, the stdio binary's credential: `<client id>:<refresh token>` from `pbcp-owner-mcp login`.

export interface Credential {
  clientId: string;
  refreshToken: string;
}

/** PBCP_SESSION as a credential; a producer token (or anything else) is refused with the reason. */
export function parseSession(value: string | undefined): Credential {
  if (!value) throw new Error('PBCP_SESSION is not set: run `pbcp-owner-mcp login <head url>` and set what it prints');
  const v = value.trim();
  if (/^pbcp_(?!rt_)/.test(v)) throw new Error('PBCP_SESSION is a producer token; this server acts as the owner and needs the session `pbcp-owner-mcp login` prints');
  const i = v.indexOf(':');
  const clientId = v.slice(0, i);
  const refreshToken = v.slice(i + 1);
  if (i < 1 || !clientId.startsWith('mcp_') || !refreshToken.startsWith('pbcp_rt_')) throw new Error('PBCP_SESSION is not a session from `pbcp-owner-mcp login`');
  return { clientId, refreshToken };
}

export const formatSession = (c: Credential) => `${c.clientId}:${c.refreshToken}`;
