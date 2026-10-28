// pnpm revoke-token <head> <root> — revokes every live token of a producer root (RFC §12: revoking is how to silence a
// producer), as the settings page's Revoke does for one token (lib/settings/producers.ts).

import { openDb } from '../db/client';
import { revokeRoot } from '../lib/settings/producers';

const [headId, root] = process.argv.slice(2);
if (!headId || !root) {
  console.error('usage: pnpm revoke-token <head> <root>');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = openDb(url, 1);
const n = await revokeRoot(db, headId, root);
console.log(n === 0 ? `${root} has no live token on ${headId}` : `revoked ${n} token${n === 1 ? '' : 's'} of ${root} on ${headId}`);
await db.$client.end();
