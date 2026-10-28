// pnpm screenshot <head> <path> <out.png> [--scheme light|dark] [--width 390] [--selector <css>] — a page of a running
// head as the owner sees it, for a PR. Signs a device in on DATABASE_URL (with SESSION_SECRET, as the head has), opens
// the page at the width, and emulates the colour scheme before the page loads, so the theme the head applies before
// paint is the scheme's (System, the default with no saved choice). With --selector, only that element. The device is
// signed out when the screenshot is taken.

import puppeteer from 'puppeteer';
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { revokeDevice, startSession } from '../lib/auth/session';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { scheme: { type: 'string', default: 'light' }, width: { type: 'string', default: '390' }, selector: { type: 'string' }, url: { type: 'string' } },
});
const [headId, path, out] = positionals;
const scheme = values.scheme;
if (!headId || !path || !out || (scheme !== 'light' && scheme !== 'dark')) {
  console.error('usage: pnpm screenshot <head> <path> <out.png> [--scheme light|dark] [--width 390] [--selector <css>] [--url <origin>]');
  process.exit(2);
}
const origin = (values.url ?? process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '');

const db = openDb(process.env.DATABASE_URL!, 1);
const session = await startSession(db, { headId, identityId: null, platform: 'web', name: 'screenshot' });
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(values.width), height: 844, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  // The session goes where the app keeps it; nothing is saved for the theme, so the page follows the scheme.
  await page.evaluateOnNewDocument((s) => localStorage.setItem('pbcp.session', s), JSON.stringify(session));
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle0' });
  const target = values.selector ? await page.waitForSelector(values.selector) : page;
  await target!.screenshot({ path: out as `${string}.png` });
  console.log(out);
} finally {
  await browser.close();
  await revokeDevice(db, { headId, deviceId: session.device_id }); // leaves no device behind in Settings
  await db.$client.end();
}
