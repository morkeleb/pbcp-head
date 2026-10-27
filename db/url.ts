// A connection string as postgres.js should see it. Hosted Postgres (Neon) hands out libpq-style URLs,
// which postgres.js reads differently in two places:
//
// - postgres.js sends any query parameter it does not know to the server as a startup parameter, and the
//   server refuses `channel_binding` (Neon adds `channel_binding=require`). postgres.js has no channel
//   binding, so the parameter is dropped; authentication is SCRAM-SHA-256 inside TLS.
// - `sslmode=require` in postgres.js encrypts without checking the certificate. Neon's certificates are
//   publicly trusted, so for a *.neon.tech host it is raised to verify-full. Anywhere else the mode is
//   kept as written; use `sslmode=verify-full` to have the certificate checked.

const LIBPQ_ONLY = ['channel_binding'];

export function connectionUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // not a URL postgres.js would have read differently; let it report the problem
  }
  for (const k of LIBPQ_ONLY) url.searchParams.delete(k);
  if (url.hostname.endsWith('.neon.tech') && url.searchParams.get('sslmode') === 'require') url.searchParams.set('sslmode', 'verify-full');
  return url.href;
}
