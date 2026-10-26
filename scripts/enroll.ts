// pnpm enroll <head> — prints a one-hour sign-in link that lets the owner register a passkey (or link an
// Apple id) on the head. This is how a head gets its first identity; afterwards a signed-in owner can add more.

import { enrollmentToken } from '../lib/auth/enroll';

const headId = process.argv[2];
if (!headId) {
  console.error('usage: pnpm enroll <head>');
  process.exit(2);
}
const origin = process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000';
console.log(`${origin}/signin?enroll=${encodeURIComponent(await enrollmentToken(headId))}`);
