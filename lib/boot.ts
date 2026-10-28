// Checks made when the head starts: at build (next.config.ts) and when a server or function boots
// (instrumentation.ts). Test mode opens /api/test, which sets the head clock; it must never run in production.

export function refuseTestModeInProduction(env: Record<string, string | undefined> = process.env): void {
  if (env.PBCP_TEST_MODE && env.VERCEL_ENV === 'production') {
    throw new Error('PBCP_TEST_MODE is set on a production deployment (VERCEL_ENV=production); refusing to start. Remove it from the project’s environment variables.');
  }
}

/**
 * OAuth for assistants (lib/oauth.ts) names its issuer and every endpoint from WEBAUTHN_ORIGIN, the head's one public
 * origin; it never takes them from a request's Host header, which a client could choose. Without it the head does
 * not start, rather than guess.
 */
export function requirePublicOrigin(env: Record<string, string | undefined> = process.env): void {
  const origin = env.WEBAUTHN_ORIGIN;
  let ok = false;
  try {
    ok = !!origin && new URL(origin).origin === origin.replace(/\/+$/, '');
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(`WEBAUTHN_ORIGIN must be set to the head's public origin (e.g. https://head.example, no path) — passkeys and OAuth for assistants are issued for it; refusing to start${origin ? ` (it is ${JSON.stringify(origin)})` : ''}. See docs/deploy.md.`);
  }
}
