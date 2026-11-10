// Local first (docs/local-first.md), in a real headless browser: the store, the event feed, the outbox and the index on
// the device. A cold open renders from the store with the network gone; a decision made offline reaches the head when
// the network returns; a card decided elsewhere meanwhile shows the head's state; a confirm card waits for the passkey;
// search finds a word in a body; an evicted or unusable store leaves the app working; two tabs never send a row twice;
// a floor raised on another device reaches the cards' controls without any card changing.

import { and, eq } from 'drizzle-orm';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cards, decisionLog } from '../../db/schema';
import { enrollmentToken } from '../../lib/auth/enroll';
import { mintProducerToken } from '../../lib/auth/producer';
import { startSession } from '../../lib/auth/session';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb, cardRow } from './helpers';

let browser: Browser;
let page: Page;
let errors: string[];
let goalpath: string;
const DECISION = 'goalpath:item:1:ship';
const shots = process.env.PBCP_SHOTS;

beforeAll(async () => {
  const path = process.env.PBCP_CHROMIUM_PATH;
  browser = await puppeteer.launch({
    headless: true,
    ...(path && path.startsWith('/') ? { executablePath: path } : {}),
    args: process.env.PBCP_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  });
});
afterAll(() => browser?.close());
afterEach(async () => {
  await page?.close();
  await call('POST', '/api/test', { body: { clock: null } });
});

const row = (id: string) => cardRow(id);
const logOf = (id: string) => testDb().select().from(decisionLog).where(and(eq(decisionLog.headId, OWNER), eq(decisionLog.cardId, id)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(150)) if (await check()) return;
  throw new Error('timed out');
}
const shows = (p: Page, text: string) => p.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15_000 }, text);

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: null } });
  goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
  await call('PUT', cardPath(DECISION), { auth: goalpath, body: card(DECISION, { title: 'When should M4 ship?', body: 'Evidence from the zanzibar benchmark.' }) });
  const context = await browser.createBrowserContext();
  page = await context.newPage();
  await page.emulateTimezone('UTC');
  page.once('close', () => void context.close().catch(() => undefined));
  await page.setViewport({ width: 360, height: 844 });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const tokens = await startSession(testDb(), { headId: OWNER, identityId: null, platform: 'web', name: 'browser' });
  await page.goto(`${headUrl()}/signin`);
  await page.evaluate((t) => localStorage.setItem('pbcp.session', JSON.stringify(t)), tokens);
});

/** The device's meta row `key`, read from its IndexedDB store. */
const meta = (p: Page, key: string) =>
  p.evaluate(
    (k, head) =>
      new Promise((resolve) => {
        const r = indexedDB.open(`pbcp-${head}`);
        r.onsuccess = () => {
          try {
            const g = r.result.transaction('meta').objectStore('meta').get(k);
            g.onsuccess = () => resolve((g.result as { value?: unknown } | undefined)?.value ?? null);
            g.onerror = () => resolve(null);
          } catch {
            resolve(null);
          } finally {
            r.result.close();
          }
        };
        r.onerror = () => resolve(null);
      }),
    key,
    OWNER,
  );

/** Opens the brief, waits for the first sync to have filled the store and the worker to control the page. */
async function synced(p: Page = page) {
  await p.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
  await shows(p, 'When should M4 ship?');
  await until(async () => (await meta(p, 'cursor')) !== null);
  await p.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
}

async function workerSession(p: Page = page): Promise<CDPSession> {
  const target = await p.browserContext().waitForTarget((t) => t.type() === 'service_worker');
  const session = await target.createCDPSession();
  await session.send('Network.enable');
  return session;
}
async function setOffline(offline: boolean, worker?: CDPSession, p: Page = page) {
  await p.setOfflineMode(offline);
  await worker?.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}
const decisionCard = (p: Page, title: string) => p.$(`xpath/.//article[@data-kind="decision"][contains(., "${title}")]`);

/** A passkey in the browser's virtual authenticator, registered through /signin's enrolment; the page is then signed in with it. */
async function passkeyOnDevice() {
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.evaluate(() => localStorage.removeItem('pbcp.session'));
  await page.goto(`${headUrl()}/signin?enroll=${encodeURIComponent(await enrollmentToken(OWNER))}`, { waitUntil: 'networkidle0' });
  await (await page.waitForSelector('xpath/.//button[contains(., "Create a passkey")]'))!.click();
  await page.waitForFunction(() => location.pathname === '/brief', { timeout: 10_000 });
}

describe('local first', () => {
  it('opens from the store with the network gone, marked "as of" until the sync returns', async () => {
    await synced();
    const worker = await workerSession();
    await setOffline(true, worker);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await shows(page, 'When should M4 ship?');
    await page.waitForSelector('.as-of');
    expect(await page.$eval('.as-of', (e) => e.textContent)).toMatch(/^as of /);
    if (shots) await page.screenshot({ path: `${shots}/as-of-360.png` });
    // Online again: the sync returns and the mark goes.
    await setOffline(false, worker);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.reload({ waitUntil: 'networkidle0' });
    await until(async () => (await page.$('.as-of')) === null);
    expect(errors).toEqual([]);
  });

  it('keeps a decision made offline, says it waits, and sends it when the network returns', async () => {
    await synced();
    const worker = await workerSession();
    await setOffline(true, worker);
    const c = (await decisionCard(page, 'When should M4 ship?'))!;
    await page.waitForSelector('.offline');
    expect(await page.$eval('.offline', (e) => e.textContent)).toMatch(/kept on this device and sent when you’re back online/);
    await c.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForSelector('[data-outbox-count="1"]');
    expect(await page.$eval('[data-outbox-count]', (e) => e.textContent)).toMatch(/1 change waiting to send/);
    if (shots) await page.screenshot({ path: `${shots}/waiting-to-send-360.png` });
    await wait(1000);
    expect((await row(DECISION)).state).toBe('open');

    await setOffline(false, worker);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await until(async () => (await row(DECISION)).state === 'decided');
    expect((await row(DECISION)).decision).toBe('approve');
    await page.waitForFunction(() => !document.querySelector('[data-outbox-count]'));
    expect(errors).toEqual([]);
  });

  it('shows the head’s state when the card was decided on another device meanwhile, and drops the row', async () => {
    await synced();
    const worker = await workerSession();
    await setOffline(true, worker);
    await (await decisionCard(page, 'When should M4 ship?'))!.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForSelector('[data-outbox-count="1"]');
    // Another device decides first.
    const laptop = await ownerSession(OWNER, 'laptop');
    expect((await call('POST', `/api/me/cards/${encodeURIComponent(DECISION)}/decision`, { auth: laptop.auth, body: { decision: 'reject' } })).status).toBe(200);

    await setOffline(false, worker);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector('[data-outbox-notice="conflict"]');
    expect(await page.$eval('[data-outbox-notice="conflict"]', (e) => e.textContent)).toBe('Decided on another device: rejected.');
    await page.waitForFunction(() => !document.querySelector('[data-outbox-count]'));
    expect((await row(DECISION)).decision).toBe('reject');
    expect(await logOf(DECISION)).toHaveLength(1);
    if (shots) {
      await (await page.$('[data-outbox-notice="conflict"]'))!.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await wait(300);
      await page.screenshot({ path: `${shots}/conflict-360.png` });
    }
  });

  it('holds a confirm card decided offline until the person confirms with their passkey', async () => {
    const bank = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'bank' })}`;
    await call('PUT', cardPath('bank:wire:1'), { auth: bank, body: card('bank:wire:1', { title: 'Wire DKK 900', sensitivity: 'confirm' }) });
    // A passkey on the device, registered through /signin's enrolment (its session starts re-identified).
    const cdp = await page.createCDPSession();
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.evaluate(() => localStorage.removeItem('pbcp.session'));
    await page.goto(`${headUrl()}/signin?enroll=${encodeURIComponent(await enrollmentToken(OWNER))}`, { waitUntil: 'networkidle0' });
    await (await page.waitForSelector('xpath/.//button[contains(., "Create a passkey")]'))!.click();
    await page.waitForFunction(() => location.pathname === '/brief', { timeout: 10_000 });
    await synced();
    const worker = await workerSession();

    await setOffline(true, worker);
    await (await decisionCard(page, 'Wire DKK 900'))!.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    expect(await page.$('[data-step-up]')).toBeNull(); // offline: no passkey to ask; the row waits
    await page.waitForSelector('[data-outbox-count="1"]');
    // Ten minutes on: the sign-in's identification has lapsed, so the head asks for the passkey at replay.
    await call('POST', '/api/test', { body: { clock: new Date(Date.now() + 10 * 60_000).toISOString() } });
    await setOffline(false, worker);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector('[data-outbox-notice="needs-person"]');
    expect(await page.$eval('[data-outbox-notice="needs-person"]', (e) => e.textContent)).toMatch(/Needs your passkey to confirm/);
    expect((await row('bank:wire:1')).state).toBe('open');
    expect(await page.$('[data-outbox-count="1"]')).not.toBeNull(); // still waiting

    await page.click('[data-outbox-confirm]');
    await page.waitForSelector('[data-step-up]');
    await page.click('[data-step-up-confirm]');
    await until(async () => (await row('bank:wire:1')).state === 'decided');
    await page.waitForFunction(() => !document.querySelector('[data-outbox-count]'));
    expect(errors).toEqual([]);
  });

  it('sends what was decided offline when the app next opens on a network, with nothing more to do', async () => {
    // The page's own network only: this is the app's sender, not the service worker.
    await page.setBypassServiceWorker(true);
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await shows(page, 'When should M4 ship?');
    await until(async () => (await meta(page, 'cursor')) !== null);
    await page.setOfflineMode(true);
    await (await decisionCard(page, 'When should M4 ship?'))!.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForSelector('[data-outbox-count="1"]');
    await wait(500);
    // The app is closed while offline.
    const context = page.browserContext();
    page.removeAllListeners('close'); // the setup closes the context with its page; this test needs the context after
    await page.close();
    await wait(1500);
    expect((await row(DECISION)).state).toBe('open');
    // Later, on a network, the app is opened again: on a page that runs no sync of its own.
    page = await context.newPage();
    await page.setBypassServiceWorker(true);
    await page.emulateTimezone('UTC');
    await page.goto(`${headUrl()}/orders`, { waitUntil: 'networkidle0' });
    await until(async () => (await row(DECISION)).state === 'decided');
    expect((await row(DECISION)).decision).toBe('approve');
    await page.waitForFunction(() => !document.querySelector('[data-outbox-count]'));
    expect(await page.$('[data-outbox-count]')).toBeNull(); // the count is 0
    page.once('close', () => void context.close().catch(() => undefined));
  });

  it('keeps a confirm row waiting for the passkey across a reload, says so on the card and in the masthead, and then sends it and the rows behind it', async () => {
    const bank = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'bank' })}`;
    await call('PUT', cardPath('bank:wire:2'), { auth: bank, body: card('bank:wire:2', { title: 'Wire DKK 1,200', sensitivity: 'confirm' }) });
    await passkeyOnDevice();
    await synced();
    const worker = await workerSession();
    await setOffline(true, worker);
    // In this order: the confirm card first, then another card behind it.
    await (await decisionCard(page, 'Wire DKK 1,200'))!.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForSelector('[data-outbox-count="1"]');
    await (await decisionCard(page, 'When should M4 ship?'))!.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForSelector('[data-outbox-count="2"]');
    await call('POST', '/api/test', { body: { clock: new Date(Date.now() + 10 * 60_000).toISOString() } }); // the sign-in's identification has lapsed
    await setOffline(false, worker);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector('[data-outbox-notice="needs-person"]');

    await page.reload({ waitUntil: 'networkidle0' });
    const wire = '[data-outbox-notice="needs-person"]';
    await page.waitForSelector(wire);
    expect(await page.$eval(wire, (e) => e.textContent)).toBe('Needs your passkey to confirm. Confirm with passkey');
    expect(await page.$(`${wire} [data-outbox-confirm]`)).not.toBeNull();
    expect(await page.$eval('[data-outbox-count]', (e) => e.textContent)).toMatch(/2 changes waiting to send — one needs your passkey/);
    expect(await page.$eval('[data-outbox-blocked]', (a) => a.getAttribute('href'))).toBe(`/card/${encodeURIComponent('bank:wire:2')}`);
    expect((await row('bank:wire:2')).state).toBe('open');
    expect((await row(DECISION)).state).toBe('open'); // behind it, waiting

    await page.click('[data-outbox-confirm]');
    await page.waitForSelector('[data-step-up]');
    await page.click('[data-step-up-confirm]');
    await until(async () => (await row('bank:wire:2')).state === 'decided' && (await row(DECISION)).state === 'decided');
    const [first] = await logOf('bank:wire:2');
    const [second] = await logOf(DECISION);
    expect(first!.seq).toBeLessThan(second!.seq); // in the order they were decided
    await page.waitForFunction(() => !document.querySelector('[data-outbox-count]'));
    expect(errors).toEqual([]);
  });

  it('finds a card by a word in its body, from the device', async () => {
    await synced();
    const asked: string[] = [];
    page.on('request', (r) => void (r.url().includes('/api/') && asked.push(new URL(r.url()).pathname)));
    await page.click('button[aria-label="Search"]');
    await page.type('input[aria-label="Search the brief"]', 'zanzibar');
    await page.waitForSelector(`[data-search-hit="${DECISION}"]`);
    expect(await page.$eval('[data-search-results]', (e) => e.textContent)).toMatch(/When should M4 ship\?/);
    expect(asked.filter((p) => p.includes('search'))).toEqual([]); // nothing asked of the head
  });

  it('keeps working when the store is evicted, and without any store at all', async () => {
    await synced();
    await page.evaluate((head) => new Promise<void>((r) => { const d = indexedDB.deleteDatabase(`pbcp-${head}`); d.onsuccess = d.onerror = d.onblocked = () => r(); }), OWNER);
    await page.reload({ waitUntil: 'networkidle0' });
    await shows(page, 'When should M4 ship?');
    await until(async () => (await meta(page, 'cursor')) !== null); // the first sync ran again
    // A browser whose storage throws (a private window): network only, no error.
    const other = await page.browserContext().newPage();
    const errs: string[] = [];
    other.on('pageerror', (e) => errs.push(String(e)));
    await other.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'indexedDB', { get() { throw new Error('no storage'); } });
    });
    await other.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await shows(other, 'When should M4 ship?');
    await (await decisionCard(other, 'When should M4 ship?'))!.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    await until(async () => (await row(DECISION)).state === 'decided');
    expect(errs).toEqual([]);
    await other.close();
  });

  it('never sends a row twice from two tabs', async () => {
    await synced();
    const second = await page.browserContext().newPage();
    await second.emulateTimezone('UTC');
    await second.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await shows(second, 'When should M4 ship?');
    const posts: string[] = [];
    for (const p of [page, second]) p.on('request', (r) => void (r.method() === 'POST' && r.url().includes('/decision') && posts.push(r.url())));
    const worker = await workerSession();
    await setOffline(true, worker);
    await second.setOfflineMode(true);
    await (await decisionCard(page, 'When should M4 ship?'))!.$eval('[data-action="approve"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForSelector('[data-outbox-count="1"]');
    await second.waitForSelector('[data-outbox-count="1"]'); // the other tab sees the row too
    await setOffline(false, worker);
    await second.setOfflineMode(false);
    await Promise.all([page, second].map((p) => p.evaluate(() => window.dispatchEvent(new Event('online')))));
    await until(async () => (await row(DECISION)).state === 'decided');
    await wait(2000);
    expect(posts).toHaveLength(1);
    expect(await logOf(DECISION)).toHaveLength(1);
    await second.close();
  });

  it('marks a card’s controls for the passkey when a floor raised on another device makes it confirm, with no card changed', async () => {
    await synced();
    expect(await (await decisionCard(page, 'When should M4 ship?'))!.$('[data-confirm-note]')).toBeNull();
    const before = (await row(DECISION)).changeSeq;
    const laptop = await ownerSession(OWNER, 'laptop');
    expect((await call('PATCH', '/api/me/producers/goalpath', { auth: laptop.auth, body: { sensitivity_floor: 'confirm' } })).status).toBe(200);
    expect((await row(DECISION)).changeSeq).toBe(before);
    await page.reload({ waitUntil: 'networkidle0' }); // the next sync
    await page.waitForFunction((t) => {
      const a = [...document.querySelectorAll('article[data-kind="decision"]')].find((x) => x.textContent!.includes(t));
      return !!a?.querySelector('[data-confirm-note]');
    }, { timeout: 15_000 }, 'When should M4 ship?');
    expect(await meta(page, 'floors')).toMatchObject({ producers: { goalpath: 'confirm' } });
  });
});
