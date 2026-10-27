// The web brief in a real (headless) browser against the head under test: it renders from /api/me only,
// decides through the §4.4 sheet behind the undo toast, records the visit on leaving, and sets seen_at when
// a card is opened.

import { and, eq } from 'drizzle-orm';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cards, decisionLog, heads } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { startSession } from '../../lib/auth/session';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, resetHead, testDb } from './helpers';

let browser: Browser;
let page: Page;
let errors: string[];
beforeAll(async () => {
  // The browser the head draws with, when it names one (the Docker image's /usr/bin/chromium).
  const path = process.env.PBCP_CHROMIUM_PATH;
  browser = await puppeteer.launch({
    headless: true,
    ...(path && path.startsWith('/') ? { executablePath: path } : {}),
    args: process.env.PBCP_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  });
});
afterAll(() => browser?.close());
afterEach(() => page?.close());

const row = async (id: string) => (await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, id))))[0]!;
async function until(check: () => Promise<boolean>, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return;
  throw new Error('timed out');
}

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: null } });
  const goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
  await call('PUT', cardPath('goalpath:item:1:ship'), { auth: goalpath, body: card('goalpath:item:1:ship', {
    title: 'When should M4 ship?',
    actions: [{ id: 'ship-friday', label: 'Ship Friday', body: 'Needs sign-off.', default: true }, { id: 'ship-next', label: 'Ship next sprint' }, 'edit'],
  }) });
  await call('PUT', cardPath('goalpath:report:1'), { auth: goalpath, body: card('goalpath:report:1', { kind: 'artifact', title: 'Burndown', body: '```mermaid\npie title Burndown\n  "Done" : 3\n  "Open" : 5\n```' }) });
  await until(async () => (await row('goalpath:report:1')).renderedHtml !== null);

  const tokens = await startSession(testDb(), { headId: OWNER, identityId: null, platform: 'web', name: 'browser' });
  // A fresh browser profile per test: the service worker and its cache would otherwise carry cards from the
  // previous test's database into this one.
  const context = await browser.createBrowserContext();
  page = await context.newPage();
  page.once('close', () => void context.close().catch(() => undefined));
  await page.setViewport({ width: 390, height: 844 });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${headUrl()}/signin`);
  await page.evaluate((t) => localStorage.setItem('pbcp.session', JSON.stringify(t)), tokens);
});

describe('web brief', () => {
  it('runs no script from inside rendered card HTML: the page CSP allows its own nonce only', async () => {
    await page.goto(`${headUrl()}/card/${encodeURIComponent('goalpath:report:1')}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.rendered');
    // Card HTML is sanitised on the server; this stands in for markup that got past it.
    const outcome = await page.evaluate(async () => {
      const w = window as unknown as { __ran?: number };
      const violations: string[] = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
      const el = document.querySelector('.rendered')!;
      el.insertAdjacentHTML('beforeend', '<img src="data:," onerror="window.__ran = 1"><a id="js" href="javascript:window.__ran = 2">x</a>');
      (document.getElementById('js') as HTMLAnchorElement).click();
      const s = document.createElement('script');
      s.textContent = 'window.__ran = 3';
      el.appendChild(s);
      await new Promise((r) => setTimeout(r, 300));
      return { ran: w.__ran ?? null, violations };
    });
    expect(outcome.ran).toBeNull();
    expect(outcome.violations.length).toBeGreaterThan(0);
    expect(outcome.violations.every((d) => d.startsWith('script-src'))).toBe(true);
    expect(errors.filter((e) => !/Content Security Policy/.test(e))).toEqual([]);
  });

  it('shows decisions and today’s folds with thumbnails, behind a strict CSP', async () => {
    const res = await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    expect(res!.headers()['content-security-policy']).toContain("img-src 'self' data:");
    const text = await page.$eval('main', (m) => m.textContent);
    expect(text).toContain('When should M4 ship?');
    expect(text).toContain('Burndown');
    const thumb = await page.$eval('.thumb img', (img) => (img as HTMLImageElement).naturalWidth);
    expect(thumb).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('decides through the choice sheet after the undo window, and logs the device', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await (await page.$('xpath/.//button[contains(., "More…")]'))!.click();
    await page.waitForSelector('.sheet');
    expect(await page.$eval('.option.selected .label', (e) => e.textContent)).toBe('Ship Friday'); // the default, preselected
    await (await page.$('xpath/.//label[contains(., "Ship next sprint")]'))!.click();
    await (await page.$('xpath/.//div[@class="sheet"]//button[.="Decide"]'))!.click();
    await page.waitForSelector('.toast');
    expect((await row('goalpath:item:1:ship')).state).toBe('open'); // still undoable
    await until(async () => (await row('goalpath:item:1:ship')).state === 'decided');
    const [log] = await testDb().select().from(decisionLog);
    expect(log).toMatchObject({ cardId: 'goalpath:item:1:ship', decision: 'ship-next' });
    expect(errors).toEqual([]);
  });

  it('undo really cancels the decision', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await (await page.$('xpath/.//button[.="Ship Friday"]'))!.click();
    await (await page.$('xpath/.//div[contains(@class,"toast")]//button[.="Undo"]'))!.click();
    await new Promise((r) => setTimeout(r, 4500));
    expect((await row('goalpath:item:1:ship')).state).toBe('open');
  });

  it('leaving the brief advances the last-visit cursor; opening a card marks it seen and its visual opens full-screen', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await page.goto(`${headUrl()}/card/${encodeURIComponent('goalpath:report:1')}`, { waitUntil: 'networkidle0' });
    await until(async () => (await testDb().select().from(heads).where(eq(heads.id, OWNER)))[0]!.lastVisitSeq > 0);
    await until(async () => (await row('goalpath:report:1')).seenAt !== null);
    await page.click('.rendered figure img');
    await page.waitForSelector('.viewer');
    expect(await page.$eval('.viewer .caption', (e) => e.textContent)).toBe('Burndown');
    expect(errors).toEqual([]);
  });
});

describe('web orders', () => {
  it('gives an order from the text field, shows its progress on the card, and cancels it after the undo window', async () => {
    const hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', executor: true })}`;
    await page.goto(`${headUrl()}/orders`, { waitUntil: 'networkidle0' });
    await page.type('textarea[aria-label="Order"]', 'Renew the parking permit\nZone 4, before Friday.');
    await (await page.$('xpath/.//button[.="Give order"]'))!.click();
    await page.waitForSelector('xpath/.//article//a[.="Renew the parking permit"]');

    const [order] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.toProducer, '*')));
    expect(order!.producerDoc).toMatchObject({ title: 'Renew the parking permit', body: 'Zone 4, before Friday.' });
    expect(order!.wildcardEligible).toEqual(['hermes']);
    await call('POST', `${cardPath(order!.id)}/claim`, { auth: hermes, body: { lease_seconds: 600 } });
    const k = order!.id.split(':')[2]!;
    for (const n of [1, 2, 3, 4]) {
      await call('PUT', cardPath(`hermes:order:${k}:progress-1-${n}`), { auth: hermes, body: card(`hermes:order:${k}:progress-1-${n}`, { kind: 'signal', urgency: 'log', thread: order!.id, title: `Step ${n}` }) });
    }

    await page.goto(`${headUrl()}/card/${encodeURIComponent(order!.id)}`, { waitUntil: 'networkidle0' });
    const text = await page.$eval('main', (m) => m.textContent);
    expect(text).toContain('held by hermes');
    expect(text).toContain('Order and progress');
    expect(text).toContain('1 earlier updates'); // four updates: one folded, the latest three shown
    await (await page.$('xpath/.//button[.="Cancel order"]'))!.click();
    await page.waitForSelector('.toast');
    await until(async () => (await row(order!.id)).execState === 'cancelled');
    expect((await row(order!.id)).state).toBe('decided');
    expect(errors).toEqual([]);
  });
});
