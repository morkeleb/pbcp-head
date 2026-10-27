// The web app as an installed app (app/manifest.ts, lib/pwa/service-worker.ts), in a real headless browser:
// what iOS Safari's "Add to Home Screen" and Chrome's install read, the brief from the cache with the network
// blocked, and writes that are refused offline rather than queued.

import { and, eq } from 'drizzle-orm';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cards, decisionLog } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { startSession } from '../../lib/auth/session';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, resetHead, testDb } from './helpers';

let browser: Browser;
let page: Page;
let errors: string[];
beforeAll(async () => {
  const path = process.env.PBCP_CHROMIUM_PATH;
  browser = await puppeteer.launch({
    headless: true,
    ...(path && path.startsWith('/') ? { executablePath: path } : {}),
    args: process.env.PBCP_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  });
});
afterAll(() => browser?.close());
afterEach(() => page?.close());

const DECISION = 'goalpath:item:1:ship';
const row = async (id: string) => (await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, id))))[0]!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: null } });
  const goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
  await call('PUT', cardPath(DECISION), { auth: goalpath, body: card(DECISION, { title: 'When should M4 ship?' }) });
  // A fresh browser profile per test: no worker or cache left from the one before.
  const context = await browser.createBrowserContext();
  page = await context.newPage();
  page.once('close', () => void context.close().catch(() => undefined));
  await page.setViewport({ width: 390, height: 844 });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const tokens = await startSession(testDb(), { headId: OWNER, identityId: null, platform: 'web', name: 'browser' });
  await page.goto(`${headUrl()}/signin`);
  await page.evaluate((t) => localStorage.setItem('pbcp.session', JSON.stringify(t)), tokens);
});

/** PNG width, height and whether it has an alpha channel, from its IHDR chunk. */
function png(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
  return { width: v.getUint32(16), height: v.getUint32(20), alpha: bytes[25] === 6 || bytes[25] === 4 };
}
const fetchPng = async (path: string) => {
  const res = await fetch(`${headUrl()}${path}`);
  expect(res.status, path).toBe(200);
  expect(res.headers.get('content-type'), path).toBe('image/png');
  return png(new Uint8Array(await res.arrayBuffer()));
};

/** The service worker's own target, to take its network away too: emulating offline on the page alone does not reach it. */
async function workerSession(): Promise<CDPSession> {
  const target = await page.browserContext().waitForTarget((t) => t.type() === 'service_worker');
  const session = await target.createCDPSession();
  await session.send('Network.enable');
  return session;
}
async function setOffline(offline: boolean, worker?: CDPSession) {
  await page.setOfflineMode(offline);
  await worker?.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}

/** Opens the brief, lets the service worker install and take over, then opens it again through the worker. */
async function briefThroughWorker() {
  await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('When should M4 ship?'));
}

describe('installable app', () => {
  it('serves a manifest with standalone display, /brief as start URL, and PNG icons of the sizes it names', async () => {
    const res = await fetch(`${headUrl()}/manifest.webmanifest`);
    expect(res.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    const m = await res.json();
    expect(m).toMatchObject({ name: 'Brief', short_name: 'Brief', start_url: '/brief', scope: '/', display: 'standalone', theme_color: '#7047f5' });
    for (const icon of m.icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(await fetchPng(icon.src), icon.src).toMatchObject({ width: w, height: h });
    }
    expect(m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    expect((await fetchPng('/icons/maskable-512.png')).alpha).toBe(false); // full-bleed: masks crop it, nothing shows through
  });

  it('has what iOS Safari’s Add to Home Screen reads, and passes Chrome’s installability check', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const head = await page.evaluate(() => {
      const attr = (sel: string, a: string) => document.querySelector(sel)?.getAttribute(a) ?? null;
      return {
        manifest: attr('link[rel="manifest"]', 'href'),
        appleIcon: attr('link[rel="apple-touch-icon"]', 'href'),
        appleIconSizes: attr('link[rel="apple-touch-icon"]', 'sizes'),
        capable: attr('meta[name="apple-mobile-web-app-capable"]', 'content') ?? attr('meta[name="mobile-web-app-capable"]', 'content'),
        title: attr('meta[name="apple-mobile-web-app-title"]', 'content'),
        status: attr('meta[name="apple-mobile-web-app-status-bar-style"]', 'content'),
        theme: attr('meta[name="theme-color"]', 'content'),
        viewport: attr('meta[name="viewport"]', 'content'),
      };
    });
    expect(head).toMatchObject({ manifest: '/manifest.webmanifest', appleIcon: '/icons/apple-touch-icon.png', appleIconSizes: '180x180', capable: 'yes', title: 'Brief', status: 'default', theme: '#7047f5' });
    expect(head.viewport).toContain('width=device-width');
    // iOS rounds the corners itself and shows transparency as black: 180×180, opaque.
    expect(await fetchPng(head.appleIcon!)).toEqual({ width: 180, height: 180, alpha: false });

    // Chrome's own reading of the manifest, and its install criteria (a manifest, icons, a worker with a fetch handler).
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await page.createCDPSession();
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(manifest.url).toBe(`${headUrl()}/manifest.webmanifest`);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    // `in-incognito` is the test's fresh browser context, not the app.
    expect(installabilityErrors.filter((e) => e.errorId !== 'in-incognito')).toEqual([]);
  });

  it('serves the worker from the root with its own policy, never from an HTTP cache', async () => {
    const res = await fetch(`${headUrl()}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'; script-src 'none'");
    expect(await res.text()).toMatch(/^\/\/ Generated by lib\/pwa\/service-worker\.ts for build "[^"]+"/);
  });
});

describe('offline', () => {
  it('renders the brief from the cache with the network blocked, marked with when it was fetched', async () => {
    await briefThroughWorker();
    expect(await page.$('.as-of')).toBeNull(); // online, the network's answer replaced the cached one
    const worker = await workerSession();
    await setOffline(true, worker);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('When should M4 ship?'));
    const asOf = await page.$eval('.as-of', (e) => e.textContent);
    expect(asOf).toMatch(/^as of /);
    // The worker's revalidation fails too, so the cached copy stays marked.
    await wait(1500);
    expect(await page.$('.as-of')).not.toBeNull();
    // A card opened online is there too; one never opened says so instead of failing.
    await page.goto(`${headUrl()}/card/${encodeURIComponent('goalpath:never:opened')}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    expect(await page.evaluate(() => document.body.innerText)).toContain('This page has not been opened on this device yet');
    expect(errors).toEqual([]);
    await setOffline(false, worker);
  });

  it('refuses a decision offline in the UI and never sends it later', async () => {
    await briefThroughWorker();
    const worker = await workerSession();
    await setOffline(true, worker);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('When should M4 ship?'));

    // Offline: the controls are disabled and say why.
    const controls = await page.$$eval('.decide-row button', (bs) => bs.map((b) => ({ text: b.textContent, disabled: (b as HTMLButtonElement).disabled })));
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((c) => c.disabled)).toBe(true);
    expect(await page.$eval('.offline', (e) => e.textContent)).toContain('nothing is saved to send later');
    await page.click('.decide-row button[data-variant="default"]').catch(() => undefined);
    await page.click('.decide-row button[data-variant="ghost"]').catch(() => undefined); // Dismiss too
    expect(await page.$('.state-line')).toBeNull();

    // Back online, nothing goes out on its own: there is no queue to send it from.
    await setOffline(false, worker);
    await page.waitForFunction(() => !(document.querySelector('.decide-row button[data-variant="default"]') as HTMLButtonElement).disabled);
    await wait(5000);
    expect((await row(DECISION)).state).toBe('open');
    expect(await testDb().select().from(decisionLog)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
