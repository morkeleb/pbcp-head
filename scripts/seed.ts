// pnpm seed <head> [--name <display name>] [--timezone <IANA zone>] [--if-new] — sets up a fresh deployment's
// first head and prints the one-hour enrolment link with which its owner registers a passkey (docs/deploy.md).
// <head> is the stable id producers address (`to_person`); --name is only how the owner is shown. --timezone
// pins the head's zone (the override); without it the head follows the zone of the owner's active device.
// --if-new does nothing when the head exists already (the Docker image runs it on every start).
//
// Run it with the deployment's own DATABASE_URL, SESSION_SECRET and WEBAUTHN_ORIGIN (on Vercel:
// `vercel env pull .env`): the link is signed with SESSION_SECRET and points at WEBAUTHN_ORIGIN. Running
// it again for the same head changes nothing but the name and timezone, if given, and prints a new link.

import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { heads } from '../db/schema';
import { enrollmentToken } from '../lib/auth/enroll';
import { ensureHead } from '../lib/heads';
import { settings, updateSettings } from '../lib/settings-me';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' }, timezone: { type: 'string' }, 'if-new': { type: 'boolean', default: false } } });
const [headId] = positionals;
if (!headId) {
  console.error('usage: pnpm seed <head> [--name "Morten"] [--timezone Europe/Copenhagen] [--if-new]');
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
  await updateSettings(db, headId, { ...(values.timezone ? { timezone: values.timezone } : {}), ...(values.name ? { display_name: values.name } : {}) });
  const s = await settings(db, headId);
  const origin = process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000';
  const zone = s.timezone_source === 'override' ? `timezone ${s.timezone}` : 'timezone: follows the owner’s devices';
  console.log(`head ${s.head}${s.display_name ? ` (${s.display_name})` : ''}, ${zone}`);
  console.log('enrol the owner’s first passkey within the hour at:');
  console.log(`${origin}/signin?enroll=${encodeURIComponent(await enrollmentToken(headId))}`);
} finally {
  await db.$client.end();
}
