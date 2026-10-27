// pnpm seed <head> [--timezone <IANA zone>] [--if-new] — sets up a fresh deployment's first head and
// prints the one-hour enrolment link with which its owner registers a passkey (docs/deploy.md).
// --if-new does nothing when the head exists already (the Docker image runs it on every start).
//
// Run it with the deployment's own DATABASE_URL, SESSION_SECRET and WEBAUTHN_ORIGIN (on Vercel:
// `vercel env pull .env`): the link is signed with SESSION_SECRET and points at WEBAUTHN_ORIGIN. Running
// it again for the same head changes nothing but the timezone, if given, and prints a new link.

import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { heads } from '../db/schema';
import { enrollmentToken } from '../lib/auth/enroll';
import { ensureHead } from '../lib/heads';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { timezone: { type: 'string' }, 'if-new': { type: 'boolean', default: false } } });
const [headId] = positionals;
if (!headId) {
  console.error('usage: pnpm seed <head> [--timezone Europe/Copenhagen]');
  process.exit(2);
}
if (values.timezone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: values.timezone });
  } catch {
    console.error(`not an IANA timezone: ${values.timezone}`);
    process.exit(2);
  }
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
if (!process.env.WEBAUTHN_ORIGIN) console.warn('WEBAUTHN_ORIGIN is not set; the link points at http://localhost:3000');

const db = openDb(url, 1);
try {
  const [existing] = await db.select({ id: heads.id }).from(heads).where(eq(heads.id, headId));
  if (existing && values['if-new']) process.exit(0);
  await ensureHead(db, headId);
  if (values.timezone) await db.update(heads).set({ timezone: values.timezone }).where(eq(heads.id, headId));
  const [head] = await db.select().from(heads).where(eq(heads.id, headId));
  const origin = process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000';
  console.log(`head ${head!.id} (timezone ${head!.timezone})`);
  console.log('enrol the owner’s first passkey within the hour at:');
  console.log(`${origin}/signin?enroll=${encodeURIComponent(await enrollmentToken(headId))}`);
} finally {
  await db.$client.end();
}
