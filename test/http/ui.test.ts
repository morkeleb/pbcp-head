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
let session: { access_token: string };
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

const decisionCard = (title: string) => page.$(`xpath/.//article[@data-kind="decision"][contains(., "${title}")]`);
const row_ = (title: string) => page.$(`xpath/.//article[contains(@class,"update-row")][.//h4[contains(., "${title}")]]`);
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
  session = tokens;
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

  it('shows decisions and today’s updates with thumbnails, behind a strict CSP', async () => {
    const res = await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    expect(res!.headers()['content-security-policy']).toContain("img-src 'self' data:");
    const text = await page.$eval('main', (m) => m.textContent);
    expect(text).toContain('When should M4 ship?');
    expect(text).toContain('Burndown');
    const thumb = (await page.$('.update-row figure img'))!;
    await thumb.scrollIntoView();
    await page.waitForFunction((img) => (img as HTMLImageElement).naturalWidth > 0, {}, thumb);
    expect(errors).toEqual([]);
  });

  it('lays out options with bodies as a radio group on the card, default pre-selected, and records the pick at once', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const article = (await decisionCard('When should M4 ship?'))!;
    expect(await article.$eval('[role="radio"][aria-checked="true"]', (e) => e.closest('label')!.textContent)).toContain('Ship Friday');
    expect(await article.$eval('[role="radio"][aria-checked="true"]', (e) => e.closest('label')!.textContent)).toContain('Needs sign-off.');
    expect(await page.$('xpath/.//button[.="Decide…"]')).toBeNull();
    await (await article.$('xpath/.//label[contains(., "Ship next sprint")]'))!.click();
    await (await article.$('xpath/.//button[@data-variant="default" and .="Ship next sprint"]'))!.click();
    // In place, at once: the buttons become a state line, the card settles to 72 %, the unseen dot goes; announced.
    await article.waitForSelector('.state-line');
    expect(await article.$eval('.state-line', (e) => e.textContent)).toMatch(/^Ship next sprint · \d\d:\d\d$/);
    await page.waitForFunction((e) => getComputedStyle(e as Element).opacity === '0.72', {}, article); // after its 150 ms fade
    expect(await article.$('[aria-label="unseen"]')).toBeNull();
    await page.waitForFunction(() => document.querySelector('[aria-live="polite"]')?.textContent?.startsWith('Ship next sprint'));
    await until(async () => (await row('goalpath:item:1:ship')).state === 'decided');
    const [log] = await testDb().select().from(decisionLog);
    expect(log).toMatchObject({ cardId: 'goalpath:item:1:ship', decision: 'ship-next' });
    expect(errors).toEqual([]);
  });

  it('offers Edit… only when actions has edit, and records `edited` with the text; a comment is behind a disclosure', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const article = (await decisionCard('When should M4 ship?'))!;
    expect(await article.$('textarea[aria-label="Comment"]')).toBeNull(); // not there until asked for
    await (await article.$('xpath/.//button[contains(., "Add a comment")]'))!.click();
    await (await article.waitForSelector('textarea[aria-label="Comment"]'))!.type('Check with Anna first.');
    await (await article.$('xpath/.//button[.="Edit…"]'))!.click();
    await (await article.waitForSelector(`textarea[id^="edit-"]`))!.type('Ship Monday instead.');
    await (await article.$('xpath/.//button[.="Send edit"]'))!.click();
    await article.waitForSelector('.state-line');
    await until(async () => (await row('goalpath:item:1:ship')).state === 'decided');
    expect(await row('goalpath:item:1:ship')).toMatchObject({ decision: 'edited', editedProposal: 'Ship Monday instead.', comment: 'Check with Anna first.' });
  });

  it('puts the buttons back with the error when the head does not record the decision', async () => {
    await page.setBypassServiceWorker(true); // so the page's own request can be answered with a failure here
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.method() === 'POST' && r.url().includes('/decision') ? void r.respond({ status: 500, contentType: 'application/json', body: '{"error":"internal","message":"internal error"}' }) : void r.continue()));
    const article = (await decisionCard('When should M4 ship?'))!;
    await (await article.$('xpath/.//button[@data-variant="default"]'))!.click();
    await article.waitForSelector('[role="alert"]');
    expect(await article.$eval('[role="alert"]', (e) => e.textContent)).toBe('internal error');
    expect(await article.$('.state-line')).toBeNull();
    expect(await article.$('xpath/.//button[@data-variant="default" and .="Ship Friday"]')).not.toBeNull();
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

  it('shows the lead and the proposal on the card, the rest behind More, and marks seen only when More opens', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const reply = (await decisionCard('Reply to Anna'))!;
    expect(await reply.$eval('.lead', (e) => e.textContent)).toBe('Anna asks whether the September invoice can be paid on the 20th.');
    expect(await reply.$eval('.proposal', (e) => e.textContent)).toContain('Hi Anna, the 20th is fine.');
    expect(await reply.$('.more-body')).toBeNull();
    expect(await reply.$('[aria-label="unseen"]')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1500));
    expect((await row('hermes:gmail:anna:reply')).seenAt).toBeNull(); // the lead alone does not present the card
    await (await reply.$('.more-trigger'))!.click();
    expect(await (await reply.waitForSelector('.more-body'))!.evaluate((e) => e.textContent)).toContain('Cash flow covers it.');
    await until(async () => (await row('hermes:gmail:anna:reply')).seenAt !== null);
    expect(await reply.$('[aria-label="unseen"]')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('takes the proposal from the first heading at any level beginning "Proposal" or "Proposed", to the next of its level or higher', async () => {
    const goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
    await call('PUT', cardPath('goalpath:item:2:plan'), { auth: goalpath, body: card('goalpath:item:2:plan', {
      title: 'Move the review?', body: 'The review clashes with the offsite.\n\n## Evidence\n\nThe calendar.\n\n### PROPOSED plan\n\nMove it to Monday.\n\n#### Detail\n\nRoom 3 is free.\n\n### Risks\n\nNone.\n\n## Proposal\n\nNot this one: the first heading wins.',
    }) });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const plan = (await decisionCard('Move the review?'))!;
    const proposal = await plan.$eval('.proposal', (e) => e.textContent);
    expect(proposal).toContain('Move it to Monday.');
    expect(proposal).toContain('Room 3 is free.');
    expect(proposal).not.toContain('None.');
    expect(proposal).not.toContain('Not this one');
    await (await plan.$('.more-trigger'))!.click();
    expect(await (await plan.waitForSelector('.more-body'))!.evaluate((e) => e.textContent)).toContain('The calendar.');
  });

  it('leads with the summary, as text, when the producer gives one', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const mail = (await decisionCard('Invoice question'))!;
    expect(await mail.$eval('.lead', (e) => e.textContent)).toBe('Anna asks to pay on the **20th**.'); // never markdown
    expect(await mail.$eval('.lead', (e) => e.innerHTML)).not.toContain('<strong>');
  });

  it('puts the actions on the card in order: a filled primary only for a default, Dismiss quiet, Edit… only when offered', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const buttons = async (title: string) => (await decisionCard(title))!.$$eval('.decide-row button', (bs) => bs.map((b) => [b.textContent, b.getAttribute('data-variant')]));
    expect(await buttons('Offsite on the 14th')).toEqual([['archive', 'outline'], ['keep', 'outline'], ['Dismiss', 'ghost']]); // no default: equal weight (§4.5)
    expect(await buttons('Reply to Anna')).toEqual([['approve', 'default'], ['reject', 'outline'], ['Edit…', 'outline'], ['Dismiss', 'ghost']]);
    const mail = (await decisionCard('Offsite on the 14th'))!;
    await (await mail.$('xpath/.//button[.="archive"]'))!.click();
    await mail.waitForSelector('.state-line');
    expect(await page.$('.toast')).toBeNull(); // a tap commits at once: no undo window
    await until(async () => (await row('mail:inbox:1')).decision === 'archive');
    expect(errors).toEqual([]);
  });

  it('acknowledges a row in place: the control becomes "Acknowledged · time"', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const fold = (await row_('Burndown'))!;
    await (await fold.$('xpath/.//button[.="Acknowledge"]'))!.click();
    await fold.waitForSelector('.state-line');
    expect(await fold.$eval('.state-line', (e) => e.textContent)).toMatch(/^Acknowledged · \d\d:\d\d$/);
    expect(await fold.$('xpath/.//button[.="Acknowledge"]')).toBeNull();
    await page.waitForFunction(() => document.querySelector('[aria-live="polite"]')?.textContent === 'Acknowledged: Burndown');
    await until(async () => (await row('goalpath:report:1')).acknowledgedAt !== null);
  });

  it('opens today with the daily paragraph so far, made of the leads, each linked to its card', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const brief = (await page.$('section[aria-label="Today’s brief"]'))!;
    expect(await brief.$eval('h2', (e) => e.textContent)).toBe('Today’s brief· so far today');
    const paragraph = await brief.$eval('.daily-paragraph', (e) => e.textContent);
    expect(paragraph).toMatch(/^4 decisions: /);
    expect(paragraph).toContain('Anna asks to pay on the **20th**'); // a summary, as text
    const links = await brief.$$eval('.daily-paragraph a', (as) => as.map((a) => a.getAttribute('href')));
    expect(links).toContain(`/card/${encodeURIComponent('hermes:gmail:anna:reply')}`);
    expect(links.every((h) => h!.startsWith('/card/'))).toBe(true);
  });

  it('commits a swipe after a 4 s undo window: right the default, Undo cancels before anything is sent, left dismisses', async () => {
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const swipe = async (title: string, dx: number) => {
      const el = (await decisionCard(title))!;
      await el.scrollIntoView();
      // On the card's own surface: a swipe that starts on a link or a button is that control's, not the card's.
      const box = (await el.boundingBox())!;
      const [x, y] = [box.x + 6, box.y + 6];
      await page.touchscreen.touchStart(x, y);
      for (let i = 1; i <= 6; i++) await page.touchscreen.touchMove(x + (dx * i) / 6, y);
      await page.touchscreen.touchEnd();
      return el;
    };
    let reply = await swipe('Reply to Anna', 140);
    await reply.waitForSelector('.toast');
    expect(await reply.$eval('.toast', (t) => t.textContent)).toContain('approve: Reply to Anna re invoice timing');
    await (await reply.$('xpath/.//div[contains(@class,"toast")]//button[.="Undo"]'))!.click();
    await new Promise((r) => setTimeout(r, 4500));
    expect((await row('hermes:gmail:anna:reply')).state).toBe('open');
    reply = await swipe('Reply to Anna', 140);
    await reply.waitForSelector('.toast');
    expect((await row('hermes:gmail:anna:reply')).state).toBe('open'); // not yet
    await until(async () => (await row('hermes:gmail:anna:reply')).decision === 'approve', 8000);
    await reply.waitForSelector('.state-line');
    const mail = await swipe('Offsite on the 14th', -140);
    await mail.waitForSelector('.toast');
    expect(await mail.$eval('.toast', (t) => t.textContent)).toContain('Dismiss: Offsite on the 14th');
    await until(async () => (await row('mail:inbox:1')).decision === 'dismissed', 8000);
    expect(errors).toEqual([]);
  });

  it('opens a diagram full-screen at least as wide as the screen, never smaller than its thumbnail', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const img = (await page.$('.update-row figure img'))!;
    await img.scrollIntoView();
    const thumb = (await img.boundingBox())!;
    await (await page.$('.update-row figure button'))!.click();
    await page.waitForSelector('.viewer .stage img');
    await page.waitForFunction(() => (document.querySelector('.viewer .stage img') as HTMLImageElement).style.width !== '');
    await new Promise((r) => setTimeout(r, 200));
    const full = (await (await page.$('.viewer .stage img'))!.boundingBox())!;
    expect(full.width).toBeGreaterThanOrEqual(390 - 1);
    expect(full.width).toBeGreaterThan(thumb.width);
    expect(errors).toEqual([]);
  });
});

describe('the brief: days, week strip, layouts', () => {
  /** Cards received yesterday, through the head's clock. */
  async function yesterday() {
    const at = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    await call('POST', '/api/test', { body: { clock: at } });
    const todoist = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'todoist' })}`;
    for (let i = 1; i <= 8; i++) {
      await call('PUT', cardPath(`todoist:old:${i}`), { auth: todoist, body: card(`todoist:old:${i}`, { producer: 'todoist', kind: 'signal', title: `Overdue item ${i}`, body: `Item ${i} is past due.` }) });
    }
    await call('POST', '/api/test', { body: { clock: null } });
  }
  const top = (sel: string) => page.$eval(sel, (e) => e.getBoundingClientRect().top);
  const mastBottom = () => page.$eval('[data-masthead]', (e) => e.getBoundingClientRect().bottom);

  it('opens on today under the masthead, loads yesterday above without moving it, and offers "Back to today" once today is out of view', async () => {
    await yesterday();
    await page.setViewport({ width: 390, height: 520 }); // short, so scrolling up into yesterday takes today out of view
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    await page.waitForSelector(`[data-day="${day}"]`); // yesterday, loaded above
    await new Promise((r) => setTimeout(r, 300));
    const today = (await page.$$eval('[data-day]', (hs) => hs.map((h) => h.getAttribute('data-day'))))[1]!;
    expect(Math.abs((await top(`[data-day="${today}"]`)) - (await mastBottom()))).toBeLessThan(6);
    expect(await page.$('xpath/.//button[contains(., "Back to today")]')).toBeNull();
    expect(await page.$eval(`[data-day="${day}"]`, (e) => e.textContent)).toMatch(/^Yesterday · /);
    await page.evaluate(() => scrollTo(0, 0)); // up into yesterday
    await page.waitForSelector('xpath/.//button[contains(., "Back to today")]');
    await (await page.$('xpath/.//button[contains(., "Back to today")]'))!.click();
    await page.waitForFunction((t) => Math.abs(document.querySelector(`[data-day="${t}"]`)!.getBoundingClientRect().top - document.querySelector('[data-masthead]')!.getBoundingClientRect().bottom) < 6, {}, today);
  });

  it('jumps to a day tapped on the week strip; the selected day is filled, days with open decisions dotted', async () => {
    await yesterday();
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    await page.waitForSelector(`[data-day="${day}"]`);
    const strip = (await page.$('nav[aria-label="Week"]'))!;
    expect(await strip.$$eval('button[aria-pressed="true"]', (bs) => bs.length)).toBe(1);
    await (await strip.$(`xpath/.//button[contains(@aria-label, "${new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))}")]`))!.click();
    await page.waitForFunction((d) => Math.abs(document.querySelector(`[data-day="${d}"]`)!.getBoundingClientRect().top - document.querySelector('[data-masthead]')!.getBoundingClientRect().bottom) < 6, {}, day);
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Week"] button[aria-pressed="true"]')?.getAttribute('aria-current') !== 'date');
  });

  it('folds updates after six behind "More signals (N)"', async () => {
    await yesterday();
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    await page.waitForSelector(`[data-day="${day}"]`);
    const section = (await page.$(`xpath/.//section[.//h2[@data-day="${day}"]]`))!;
    expect(await section.$$eval('.update-row', (rs) => rs.length)).toBe(6);
    const more = (await section.$('xpath/.//button[contains(., "More signals (2)")]'))!;
    await more.evaluate((b) => b.scrollIntoView({ block: 'center' })); // clear of the fixed footer
    await more.click();
    await page.waitForFunction((sec) => (sec as Element).querySelectorAll('.update-row').length === 8, {}, section);
  });

  it('lists tomorrow: a card snoozed until then, or says in one line that nothing is set', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const tomorrow = (await page.$$eval('[data-day]', (hs) => hs.map((h) => h.getAttribute('data-day')))).at(-1)!;
    const section = (await page.$(`xpath/.//section[.//h2[@data-day="${tomorrow}"]]`))!;
    expect(await section.evaluate((e) => e.textContent)).toContain('Nothing set for tomorrow yet.');
    const s = await call('POST', `/api/me/cards/${encodeURIComponent('goalpath:item:1:ship')}/snooze`, { auth: `Session ${session.access_token}`, body: { preset: 'tomorrow' } });
    expect(s.status).toBe(200);
    await page.reload({ waitUntil: 'networkidle0' });
    const after = (await page.$(`xpath/.//section[.//h2[@data-day="${tomorrow}"]]`))!;
    expect(await after.evaluate((e) => e.textContent)).toContain('When should M4 ship?');
  });

  it('remembers Ledger density on the device: a decision folded to its title and actions, expandable', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await (await page.$('xpath/.//button[starts-with(@aria-label, "Density")]'))!.click();
    await (await page.waitForSelector('xpath/.//*[@role="menuitemradio" and contains(., "Ledger")]'))!.click();
    await page.reload({ waitUntil: 'networkidle0' });
    const article = (await decisionCard('When should M4 ship?'))!;
    expect(await article.$('.lead')).toBeNull(); // folded
    await (await article.$('button[aria-expanded="false"]'))!.click();
    await article.waitForSelector('.lead');
  });

  it('ledger on a phone: the title whole on its own line, the actions on the next, choice lists inline with no "Choose…"', async () => {
    const long = 'Approve the revised Q4 budget for the platform team, including the two new contractor positions';
    const goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
    await call('PUT', cardPath('goalpath:item:9:budget'), { auth: goalpath, body: card('goalpath:item:9:budget', { title: long }) });
    await page.setViewport({ width: 360, height: 780 });
    await page.goto(`${headUrl()}/signin`);
    await page.evaluate(() => localStorage.setItem('pbcp.density', 'ledger'));
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });

    const budget = (await decisionCard('Approve the revised Q4 budget'))!;
    const layout = await budget.evaluate((e) => {
      const title = e.querySelector('.ledger-title')!;
      const text = [...title.querySelectorAll('span')].find((s) => s.textContent?.startsWith('Approve'))!;
      const row = e.querySelector('.decide-row')!.getBoundingClientRect();
      return {
        shown: text.textContent,
        clipped: text.scrollWidth > text.clientWidth + 1 || getComputedStyle(text).textOverflow === 'ellipsis' || !!title.querySelector('.truncate'),
        below: row.top >= title.getBoundingClientRect().bottom - 1,
      };
    });
    expect(layout).toEqual({ shown: long, clipped: false, below: true });

    // A choice list with option bodies: its options inline, the default filled, no "Choose…" in front of them (§4.5).
    const ship = (await decisionCard('When should M4 ship?'))!;
    expect(await ship.$$eval('.decide-row button', (bs) => bs.map((b) => [b.textContent, b.getAttribute('data-variant')]))).toEqual([
      ['Ship Friday', 'default'], ['Ship next sprint', 'outline'], ['Dismiss', 'ghost'],
    ]);
    expect(await ship.$('xpath/.//button[contains(., "Choose")]')).toBeNull();
    await (await ship.$('xpath/.//button[.="Ship next sprint"]'))!.click();
    await until(async () => (await row('goalpath:item:1:ship')).decision === 'ship-next');
    expect(errors).toEqual([]);
  });

  it('shows the swipe hint once per device, and takes it down after a few seconds', async () => {
    await page.goto(`${headUrl()}/signin`);
    await page.evaluate(() => localStorage.removeItem('pbcp.swipe-hint'));
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const footer = () => page.$eval('footer', (f) => f.textContent ?? '');
    expect(await footer()).toContain('Swipe right for the default');
    await page.waitForFunction(() => !document.querySelector('footer')!.textContent!.includes('Swipe right'), { timeout: 12_000 });
    await page.reload({ waitUntil: 'networkidle0' });
    expect(await footer()).not.toContain('Swipe right');
  });


  it('broadsheet: two columns, j/k move, d dismisses the focused decision after the undo window', async () => {
    await page.setViewport({ width: 1100, height: 900 });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    expect(await page.$eval('footer', (f) => f.textContent)).toContain('j / k move · enter open · d dismiss');
    const columns = await page.$eval('section[data-section] > div.grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').map(parseFloat));
    expect(columns[0]! / (columns[0]! + columns[1]!)).toBeGreaterThan(0.55);
    await page.keyboard.press('j');
    const focused = await page.$eval('[data-card].ring-2', (e) => e.getAttribute('data-card'));
    expect(focused).toBe('goalpath:item:1:ship');
    await page.keyboard.press('d');
    await page.waitForSelector('.toast');
    await until(async () => (await row('goalpath:item:1:ship')).decision === 'dismissed', 8000);
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
