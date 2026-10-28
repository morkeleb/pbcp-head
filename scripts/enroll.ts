// pnpm enroll <head> — prints a one-hour sign-in link that lets the owner register a passkey (or link an
// Apple id) on the head. This is how a head gets its first identity; afterwards a signed-in owner makes more from
// Settings → Devices, which uses the same code (lib/settings/devices.ts).

import { enrolmentLink } from '../lib/settings/devices';
import { headOrigin } from '../lib/settings/head';

const headId = process.argv[2];
if (!headId) {
  console.error('usage: pnpm enroll <head>');
  process.exit(2);
}
console.log((await enrolmentLink(headId, headOrigin())).url);
