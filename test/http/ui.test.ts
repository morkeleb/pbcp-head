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

  it('lays out options with bodies as a group on the card, default pre-selected, and records the pick at once', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const article = (await page.$('xpath/.//article[.//h3[contains(., "When should M4 ship?")]]'))!;
    expect(await article.$eval('.option.selected .label', (e) => e.textContent)).toBe('Ship Friday');
    expect(await article.$eval('.option.selected .option-body', (e) => e.textContent)).toContain('Needs sign-off.');
    expect(await page.$('.sheet')).toBeNull();
    expect(await page.$('xpath/.//button[.="Decide…"]')).toBeNull();
    await (await article.$('xpath/.//label[contains(., "Ship next sprint")]'))!.click();
    await (await article.$('xpath/.//button[contains(@class,"primary") and .="Ship next sprint"]'))!.click();
    // In place, at once: the controls give way to the state, the card dims, and it is announced.
    await article.waitForSelector('.decided-line');
    expect(await article.$eval('.decided-line', (e) => e.textContent)).toMatch(/^Decided: Ship next sprint · \d\d:\d\d$/);
    expect(await article.evaluate((e) => e.classList.contains('done'))).toBe(true);
    expect(await article.$('.badge.new')).toBeNull();
    await page.waitForFunction(() => document.querySelector('[aria-live="polite"]')?.textContent?.startsWith('Decided: Ship next sprint'));
    await until(async () => (await row('goalpath:item:1:ship')).state === 'decided');
    const [log] = await testDb().select().from(decisionLog);
    expect(log).toMatchObject({ cardId: 'goalpath:item:1:ship', decision: 'ship-next' });
    expect(errors).toEqual([]);
  });

  it('offers Edit… only when actions has edit, and records `edited` with the text; a comment is behind a disclosure', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const article = (await page.$('xpath/.//article[.//h3[contains(., "When should M4 ship?")]]'))!;
    expect(await article.$eval('details.comment', (d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await article.$eval('textarea[aria-label="Comment"]', (t) => t.checkVisibility())).toBe(false); // not shown until asked for
    await (await article.$('details.comment summary'))!.click();
    await (await article.$('textarea[aria-label="Comment"]'))!.type('Check with Anna first.');
    await (await article.$('xpath/.//button[.="Edit…"]'))!.click();
    await (await article.waitForSelector('.edit textarea'))!.type('Ship Monday instead.');
    await (await article.$('xpath/.//button[.="Send edit"]'))!.click();
    await article.waitForSelector('.decided-line');
    await until(async () => (await row('goalpath:item:1:ship')).state === 'decided');
    expect(await row('goalpath:item:1:ship')).toMatchObject({ decision: 'edited', editedProposal: 'Ship Monday instead.', comment: 'Check with Anna first.' });
  });

  it('puts the controls back with the error when the head does not record the decision', async () => {
    // Without the service worker, so the page's own request can be answered with a failure here.
    await page.setBypassServiceWorker(true);
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.method() === 'POST' && r.url().includes('/decision') ? void r.respond({ status: 500, contentType: 'application/json', body: '{"error":"internal","message":"internal error"}' }) : void r.continue()));
    const article = (await page.$('xpath/.//article[.//h3[contains(., "When should M4 ship?")]]'))!;
    await (await article.$('xpath/.//button[contains(@class,"primary")]'))!.click();
    await article.waitForSelector('.error');
    expect(await article.$eval('.error', (e) => e.textContent)).toBe('internal error');
    expect(await article.$('.decided-line')).toBeNull();
    expect(await article.$('xpath/.//button[contains(@class,"primary") and .="Ship Friday"]')).not.toBeNull();
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

describe('the brief: lead, proposal, More', () => {
  beforeEach(async () => {
    const mail = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'mail' })}`;
    await call('PUT', cardPath('mail:inbox:1'), { auth: mail, body: card('mail:inbox:1', {
      producer: 'mail', title: 'Offsite on the 14th: are you in?', actions: ['archive', 'keep'],
      body: '- **From:** Jonas\n\n> Can you confirm by Friday whether you join for both days?',
    }) });
    const hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
    await call('PUT', cardPath('hermes:gmail:anna:reply'), { auth: hermes, body: card('hermes:gmail:anna:reply', {
      producer: 'hermes', title: 'Reply to Anna re invoice timing', actions: ['approve', 'reject', 'edit'],
      body: 'Anna asks whether the September invoice can be paid on the 20th.\n\n## Evidence\n\nCash flow covers it.\n\n## Proposed reply\n\n> Hi Anna, the 20th is fine.',
    }) });
    await call('PUT', cardPath('mail:inbox:2'), { auth: mail, body: card('mail:inbox:2', {
      producer: 'mail', title: 'Invoice question', actions: ['archive', 'keep'], summary: 'Anna asks to pay on the **20th**.',
      body: 'The full mail, quoted.',
    }) });
  });
  const article = (title: string) => page.$(`xpath/.//article[.//h3[contains(., "${title}")]]`);

  it('shows the lead and the proposal on the card, the rest behind More, and marks seen only when More opens', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const reply = (await article('Reply to Anna'))!;
    expect(await reply.$eval('.lead', (e) => e.textContent)).toBe('Anna asks whether the September invoice can be paid on the 20th.');
    expect(await reply.$eval('.proposal', (e) => e.textContent)).toContain('Hi Anna, the 20th is fine.');
    expect(await reply.$eval('details.more', (d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await reply.$eval('details.more', (d) => d.textContent)).toContain('Cash flow covers it.');
    expect(await page.$('xpath/.//button[.="Read"]')).toBeNull();
    await new Promise((r) => setTimeout(r, 1500));
    expect((await row('hermes:gmail:anna:reply')).seenAt).toBeNull(); // the lead alone does not present the card
    await (await reply.$('details.more summary'))!.click();
    await until(async () => (await row('hermes:gmail:anna:reply')).seenAt !== null);
    expect(errors).toEqual([]);
  });

  it('takes the proposal from the first H2 beginning "Proposal" or "Proposed" only', async () => {
    const goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
    await call('PUT', cardPath('goalpath:item:2:plan'), { auth: goalpath, body: card('goalpath:item:2:plan', {
      title: 'Move the review?', body: 'The review clashes with the offsite.\n\n### Proposed plan\n\nMove it to Monday.\n\n## proposal\n\nMove it to Tuesday.\n\n### Detail\n\nRoom 3 is free.\n\n## Evidence\n\nThe calendar.',
    }) });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const plan = (await article('Move the review?'))!;
    const proposal = await plan.$eval('.proposal', (e) => e.textContent);
    expect(proposal).toContain('Move it to Tuesday.'); // the H2, case-insensitive, to the next H1 or H2
    expect(proposal).toContain('Room 3 is free.'); // an H3 inside it stays in it
    expect(proposal).not.toContain('Move it to Monday.'); // an H3 "Proposed …" is not the proposal
    expect(proposal).not.toContain('The calendar.');
    expect(await plan.$eval('details.more', (d) => d.textContent)).toContain('Move it to Monday.');
  });

  it('leads with the summary, as text, when the producer gives one', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const mail = (await article('Invoice question'))!;
    expect(await mail.$eval('.lead', (e) => e.textContent)).toBe('Anna asks to pay on the **20th**.'); // never markdown
    expect(await mail.$eval('.lead', (e) => e.innerHTML)).not.toContain('<strong>');
    expect(await mail.$eval('details.more', (d) => d.textContent)).toContain('The full mail, quoted.');
  });

  it('puts a bare-string list on the card as buttons: a filled primary only for a default, Dismiss quiet, no Edit… unless offered', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const mail = (await article('Offsite on the 14th'))!;
    const buttons = await mail.$$eval('.row.decide button', (bs) => bs.map((b) => [b.textContent, b.className]));
    expect(buttons).toEqual([['archive', ''], ['keep', ''], ['Dismiss', 'quiet']]); // no default: equal weight (§4.5)
    const reply = (await article('Reply to Anna'))!;
    expect(await reply.$$eval('.row.decide button', (bs) => bs.map((b) => [b.textContent, b.className]))).toEqual([['approve', 'primary'], ['reject', ''], ['Edit…', ''], ['Dismiss', 'quiet']]);
    await (await mail.$('xpath/.//button[.="archive"]'))!.click();
    await mail.waitForSelector('.decided-line');
    expect(await page.$('.toast')).toBeNull(); // a tap commits at once: no undo window
    await until(async () => (await row('mail:inbox:1')).decision === 'archive');
    expect(errors).toEqual([]);
  });

  it('acknowledges in place: the button becomes the time, the card collapses to title and lead, not new any more', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const fold = (await article('Burndown'))!;
    expect(await fold.$('.thumb')).not.toBeNull();
    await (await fold.$('xpath/.//button[.="Acknowledge"]'))!.click();
    await fold.waitForSelector('.decided-line');
    expect(await fold.$eval('.decided-line', (e) => e.textContent)).toMatch(/^Acknowledged \d\d:\d\d$/);
    expect(await fold.$('button')).toBeNull();
    expect(await fold.$('.thumb')).toBeNull();
    expect(await fold.$('.badge.new')).toBeNull();
    await page.waitForFunction(() => document.querySelector('[aria-live="polite"]')?.textContent === 'Acknowledged: Burndown');
    await until(async () => (await row('goalpath:report:1')).acknowledgedAt !== null);
  });

  it('heads the page with the brief so far today until the nightly card exists', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const top = (await page.$('main section.card.daily'))!;
    expect(await top.$eval('h3', (e) => e.textContent)).toBe('So far today');
    const text = await top.evaluate((e) => e.textContent);
    expect(text).toContain('Reply to Anna re invoice timing — Anna asks whether the September invoice can be paid on the 20th.');
    expect(text).toContain('Invoice question — Anna asks to pay on the **20th**.');
    expect(text).toMatch(/4 open decisions · \d+ cards? today from \d+ producers?/);
  });

  it('commits a swipe after a 4 s undo window: right the default, Undo cancels before anything is sent, left without reject does nothing', async () => {
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const swipe = async (title: string, dx: number) => {
      const el = (await article(title))!;
      await el.scrollIntoView();
      const box = (await (await el.$('.meta'))!.boundingBox())!;
      const [x, y] = [box.x + 150, box.y + box.height / 2];
      await page.touchscreen.touchStart(x, y);
      for (let i = 1; i <= 6; i++) await page.touchscreen.touchMove(x + (dx * i) / 6, y);
      await page.touchscreen.touchEnd();
      return el;
    };
    // Swipe right with Undo: nothing is sent.
    let reply = await swipe('Reply to Anna', 140);
    await reply.waitForSelector('.toast');
    expect(await reply.$eval('.toast', (t) => t.textContent)).toContain('approve: Reply to Anna re invoice timing');
    await (await reply.$('xpath/.//div[contains(@class,"toast")]//button[.="Undo"]'))!.click();
    await new Promise((r) => setTimeout(r, 4500));
    expect((await row('hermes:gmail:anna:reply')).state).toBe('open');
    // Swipe right, left alone: the default, after the window.
    reply = await swipe('Reply to Anna', 140);
    await reply.waitForSelector('.toast');
    expect((await row('hermes:gmail:anna:reply')).state).toBe('open'); // not yet
    await until(async () => (await row('hermes:gmail:anna:reply')).decision === 'approve', 8000);
    await reply.waitForSelector('.decided-line');
    // Swipe left on a card that offers no reject: nothing at all.
    const mail = await swipe('Offsite on the 14th', -140);
    await new Promise((r) => setTimeout(r, 300));
    expect(await mail.$('.toast')).toBeNull();
    expect((await row('mail:inbox:1')).state).toBe('open');
    expect(errors).toEqual([]);
  });

  it('opens a diagram full-screen at least as wide as the screen, never smaller than its thumbnail', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const thumb = (await (await page.$('.thumb img'))!.boundingBox())!;
    await page.click('.thumb img');
    await page.waitForSelector('.viewer .stage img');
    await page.waitForFunction(() => (document.querySelector('.viewer .stage img') as HTMLImageElement).style.width !== '');
    await new Promise((r) => setTimeout(r, 200));
    const full = (await (await page.$('.viewer .stage img'))!.boundingBox())!;
    expect(full.width).toBeGreaterThanOrEqual(390 - 1);
    expect(full.width).toBeGreaterThan(thumb.width);
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
