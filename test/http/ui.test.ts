// The web brief in a real (headless) browser against the head under test: it renders from /api/me only,
// decides through the §4.4 sheet behind the undo toast, records the visit on leaving, and sets seen_at when
// a card is opened.

import { and, eq } from 'drizzle-orm';
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cards, decisionLog, heads } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { startSession } from '../../lib/auth/session';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

let browser: Browser;
let page: Page;
let errors: string[];
let session: { access_token: string; device_id: string };
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
  // The device's zone is the head's (X-Timezone); the fixtures date cards in UTC, so the browser lives in UTC too, or the
  // two disagree on what today is for the hours around midnight.
  await page.emulateTimezone('UTC');
  page.once('close', () => void context.close().catch(() => undefined));
  await page.setViewport({ width: 390, height: 844 });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${headUrl()}/signin`);
  await page.evaluate((t) => localStorage.setItem('pbcp.session', JSON.stringify(t)), tokens);
});

describe('web brief', () => {
  /** What a card's source link shows: the label and host that are on its line (not clipped), left to right. */
  const shownSource = (sel: string) =>
    page.$eval(`${sel} [data-source]`, (a) => {
      const box = a.getBoundingClientRect();
      const visible = (e: Element | null) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.width > 0 ? { text: e.textContent!.replace(/\s*·\s*$/, ''), left: r.left } : null;
      };
      const label = visible(a.querySelector('[data-source-label]'));
      const host = visible(a.querySelector('[data-source-host]'));
      return {
        shown: [label, host].filter((x): x is { text: string; left: number } => x !== null).sort((x, y) => x.left - y.left).map((x) => x.text),
        href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'),
        lineHeight: a.parentElement!.getBoundingClientRect().height,
      };
    });

  it('puts the source on the card’s header line as "label · host ↗", in a new tab; none without a followable source, and not in the menu', async () => {
    const goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
    const put = (id: string, extra: Record<string, unknown>) => call('PUT', cardPath(id), { auth: goalpath, body: card(id, extra) });
    await put('goalpath:item:2:src', { title: 'Accept GP-2?', source: { url: 'https://goalpath.example/items/GP-2', label: 'GP-2' } });
    await put('goalpath:report:2', { kind: 'artifact', title: 'Velocity', source: { url: 'https://reports.example/velocity' } });
    await put('goalpath:report:4', { kind: 'artifact', title: 'Same', source: { url: 'https://www.same.example/x', label: 'same.example' } });
    await put('goalpath:report:3', { kind: 'signal', title: 'Odd link', source: { url: 'javascript:alert(1)', label: 'Click me' } });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });

    const decision = (await decisionCard('Accept GP-2?'))!;
    expect(await shownSource('article[data-card="goalpath:item:2:src"]')).toEqual({
      shown: ['GP-2', 'goalpath.example'], href: 'https://goalpath.example/items/GP-2', target: '_blank', rel: 'noopener', lineHeight: expect.any(Number),
    });
    // The header is one line: the source sits beside the producer.
    expect(await decision.$eval('[data-source]', (a) => a.parentElement!.textContent)).toMatch(/^goalpath/i);
    expect(await decision.$eval('[data-source]', (a) => a.getAttribute('aria-label'))).toBe('GP-2, goalpath.example (opens in a new tab)');
    expect((await shownSource('article[data-card="goalpath:item:2:src"]')).lineHeight).toBeLessThan(24);
    expect((await shownSource('article[data-card="goalpath:report:2"]')).shown).toEqual(['reports.example']); // no label: the host
    expect((await shownSource('article[data-card="goalpath:report:4"]')).shown).toEqual(['www.same.example']); // the label is the host: once

    // No source, or one that is not http(s)/mailto (§3.1 Links): no link.
    expect(await page.$('article[data-card="goalpath:item:1:ship"] [data-source]')).toBeNull();
    expect(await page.$('article[data-card="goalpath:report:3"] [data-source]')).toBeNull();
    expect(await page.$eval('article[data-card="goalpath:report:3"]', (a) => a.textContent)).not.toContain('Click me');

    // The menu no longer offers it.
    await (await decision.$('button[aria-label^="More actions"]'))!.click();
    await page.waitForSelector('[role="menu"]');
    expect(await page.$eval('[role="menu"]', (m) => m.textContent)).not.toMatch(/Open source/);
  });

  it('at 360 px keeps the header on one line by dropping the source’s label, never its host, and never touching the title', async () => {
    const goalpath = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'goalpath' })}`;
    const label = 'A long label for the upstream tracker entry';
    await call('PUT', cardPath('goalpath:item:3:long'), { auth: goalpath, body: card('goalpath:item:3:long', { title: 'Ship the export?', labels: ['billing-revamp'], source: { url: 'https://gp.example/3', label } }) });
    await page.setViewport({ width: 360, height: 780 });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const article = (await decisionCard('Ship the export?'))!;
    const shown = await shownSource('article[data-card="goalpath:item:3:long"]');
    expect(shown.shown).toEqual(['gp.example']);
    // The host is whole: the labels truncate before it does (RFC 0.7 §4.1 on the same line).
    expect(await article.$eval('[data-source-host] span', (t) => t.scrollWidth <= t.clientWidth)).toBe(true);
    expect(await article.$eval('[data-labels]', (l) => l.scrollWidth > l.clientWidth)).toBe(true);
    expect(shown.lineHeight).toBeLessThan(24); // one line
    expect(await article.$eval('[data-source]', (a) => a.getBoundingClientRect().right <= a.parentElement!.getBoundingClientRect().right + 1)).toBe(true);
    expect(await article.$eval('h3', (h) => h.textContent)).toBe('Ship the export?'); // the title whole
    // Wide enough, both again.
    await page.setViewport({ width: 1280, height: 800 });
    await until(async () => (await shownSource('article[data-card="goalpath:item:3:long"]')).shown.length === 2);
  });

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
    // Clear of the fixed footer: puppeteer clicks a button already in the viewport where it is, even under it.
    await article.evaluate((a) => a.scrollIntoView({ block: 'center' }));
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

  it('opens today with the daily paragraph so far: each card’s title, linked to it, then its lead', async () => {
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const brief = (await page.$('section[aria-label="Today’s brief"]'))!;
    expect(await brief.$eval('h2', (e) => e.textContent)).toBe('Today’s brief· so far today');
    const paragraph = await brief.$eval('.daily-paragraph', (e) => e.textContent);
    expect(paragraph).toMatch(/^4 decisions: /);
    expect(paragraph).toContain('Anna asks to pay on the **20th**'); // a summary, as text
    const links = await brief.$$eval('.daily-paragraph a', (as) => as.map((a) => a.getAttribute('href')));
    expect(links).toContain(`/card/${encodeURIComponent('hermes:gmail:anna:reply')}`);
    expect(links.every((h) => h!.startsWith('/card/'))).toBe(true);
    expect(paragraph).toContain('Reply to Anna re invoice timing — Anna asks whether the September invoice can be paid on the 20th');
    expect(await brief.$eval(`.daily-paragraph a[href="/card/${encodeURIComponent('hermes:gmail:anna:reply')}"]`, (a) => a.textContent)).toBe('Reply to Anna re invoice timing');
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
    // Today is below the view now: the chip points down, the way to scroll.
    expect(await page.$eval('[data-today-is]', (b) => [b.getAttribute('data-today-is'), !!b.querySelector('.lucide-arrow-down'), !!b.querySelector('.lucide-arrow-up')])).toEqual(['below', true, false]);
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

  /** One signal `days` days ago, through the head's clock; its local day (the test head is on UTC). */
  async function daysAgo(days: number, title: string) {
    const at = new Date(Date.now() - days * 24 * 3600 * 1000);
    await call('POST', '/api/test', { body: { clock: at.toISOString().replace(/\.\d+Z$/, 'Z') } });
    const cal = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'cal' })}`;
    const id = `cal:old:${days}`;
    await call('PUT', cardPath(id), { auth: cal, body: card(id, { producer: 'cal', kind: 'signal', title, body: `${title}.` }) });
    await call('POST', '/api/test', { body: { clock: null } });
    return at.toISOString().slice(0, 10);
  }
  const atMasthead = (d: string) =>
    page.waitForFunction((d) => Math.abs(document.querySelector(`[data-day="${d}"]`)!.getBoundingClientRect().top - document.querySelector('[data-masthead]')!.getBoundingClientRect().bottom) < 6, {}, d);

  it('loads earlier days a week at a time as far back as the head has cards, skipping empty weeks, with no cap', async () => {
    const oldest = await daysAgo(100, 'Back in the summer');
    const middle = await daysAgo(45, 'Six weeks ago');
    const recent = await daysAgo(3, 'Three days ago');
    const weeks: string[] = [];
    page.on('request', (r) => r.url().includes('/api/me/cards?from=') && weeks.push(new URL(r.url()).searchParams.get('from')!));
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`[data-day="${recent}"]`);
    // Scroll to the top until the oldest day is in and nothing more loads.
    await until(async () => {
      await page.evaluate(() => scrollTo(0, 0));
      return (await page.$(`[data-day="${oldest}"]`)) !== null;
    }, 20_000);
    await page.evaluate(() => scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 800));
    const shown = await page.$$eval('[data-day]', (hs) => hs.map((h) => h.getAttribute('data-day')!));
    expect(shown.slice(0, 3)).toEqual([oldest, middle, recent]); // empty days have no header
    expect(await page.$eval('main', (m) => m.textContent)).not.toMatch(/goes back/);
    // A week per fetch, and no fetch for the empty weeks between the cards: yesterday's week, then one per card.
    expect(weeks).toHaveLength(3);
  });

  it('the week strip’s month label opens a date picker that jumps to any day back to the first card, loading it', async () => {
    const oldest = await daysAgo(100, 'Back in the summer');
    await daysAgo(3, 'Three days ago');
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-month]');
    const month = (d: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
    expect((await page.$eval('[data-month]', (b) => b.textContent))!.toLowerCase()).toContain(month(new Date().toISOString().slice(0, 10)).toLowerCase());
    await (await page.$('[data-month]'))!.click();
    await page.waitForSelector('[data-date-picker]');
    // Back to the oldest card's month; no further.
    while (!(await page.$(`[data-date-picker] [data-date="${oldest}"]`))) await (await page.$('[data-date-picker] button[aria-label="Previous month"]'))!.click();
    expect(await page.$eval('[data-date-picker] button[aria-label="Previous month"]', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    const dayBefore = new Date(Date.parse(`${oldest}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (dayBefore.slice(0, 7) === oldest.slice(0, 7)) {
      expect(await page.$eval(`[data-date-picker] [data-date="${dayBefore}"]`, (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    }
    await (await page.$(`[data-date-picker] [data-date="${oldest}"]`))!.click();
    await page.waitForSelector(`[data-day="${oldest}"]`);
    await atMasthead(oldest);
    await page.waitForFunction(() => !document.querySelector('[data-date-picker]')); // closed on the pick
    expect(await page.$eval('nav[aria-label="Week"] button[aria-pressed="true"]', (b) => b.getAttribute('aria-label'))).toContain(
      new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${oldest}T00:00:00Z`)),
    );

    // A day loaded but empty: shown when picked, saying so.
    const empty = new Date(Date.parse(`${oldest}T00:00:00Z`) + 20 * 86_400_000).toISOString().slice(0, 10);
    await (await page.$('[data-month]'))!.click();
    await page.waitForSelector('[data-date-picker]');
    while (!(await page.$(`[data-date-picker] [data-date="${empty}"]`))) await (await page.$('[data-date-picker] button[aria-label="Next month"]'))!.click();
    await (await page.$(`[data-date-picker] [data-date="${empty}"]`))!.click();
    await atMasthead(empty);
    expect(await page.$eval(`xpath/.//section[.//h2[@data-day="${empty}"]]`, (s) => s.textContent)).toContain('Nothing arrived this day.');
    expect(errors).toEqual([]);
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

describe('labels and a card’s day (RFC 0.7)', () => {
  async function seed() {
    const hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', ceiling: 'immediate' })}`;
    const put = (id: string, extra: Record<string, unknown>) => call('PUT', cardPath(id), { auth: hermes, body: card(id, extra) });
    await put('hermes:x:alpha-d', { title: 'Alpha decision', summary: 'About alpha.', labels: ['alpha', 'zeta'] });
    await put('hermes:x:beta-d', { title: 'Beta decision', summary: 'About beta.', labels: ['beta'] });
    await put('hermes:x:alpha-u', { kind: 'artifact', title: 'Alpha update', summary: 'An alpha report.', labels: ['alpha'] });
    await put('hermes:x:beta-s', { kind: 'signal', title: 'Beta signal', summary: 'A beta alert.', labels: ['beta'] });
  }
  const titles = (sel: string) => page.$$eval(sel, (as) => as.map((a) => a.querySelector('h3, h4')?.textContent?.trim() ?? ''));
  const today = () => page.$('xpath/.//section[@data-section][.//h2[starts-with(., "Today")]]');

  it('shows labels on the card header in the producer’s order, the ledger the first only', async () => {
    await seed();
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    expect(await page.$eval('article[data-card="hermes:x:alpha-d"] [data-labels]', (l) => l.textContent)).toBe('alpha · zeta');
    expect(await page.$eval('article[data-card="hermes:x:alpha-d"] [data-labels]', (l) => l.parentElement!.textContent)).toMatch(/^hermes·alpha · zeta/i);
    await page.evaluate(() => localStorage.setItem('pbcp.density', 'ledger'));
    await page.reload({ waitUntil: 'networkidle0' });
    expect(await page.$eval('article[data-card="hermes:x:alpha-d"] [data-labels]', (l) => l.textContent)).toBe(' · alpha');
  });

  it('filters by label: decisions, updates, signals and the daily paragraph all narrow; remembered on the device; cleared', async () => {
    await seed();
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const section = (await today())!;
    expect(await section.$$eval('[data-card]', (cs) => cs.length)).toBeGreaterThanOrEqual(5); // goalpath's two + the four above
    // The filter lists the labels on the loaded days, with counts.
    await (await page.$('[data-label-filter] button'))!.click();
    await page.waitForSelector('[data-label="alpha"]');
    expect(await page.$$eval('[role="menuitemcheckbox"][data-label]', (is) => is.map((i) => i.textContent))).toEqual(['alpha2', 'beta2', 'zeta1']);
    await (await page.$('[data-label="alpha"]'))!.click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('article[data-card="hermes:x:beta-d"]'));

    const shown = async () => ({
      decisions: await titles('section[data-section] article[data-kind="decision"]'),
      rows: await titles('section[data-section] article.update-row'),
      paragraph: await page.$eval('.daily-paragraph', (p) => [...p.querySelectorAll('a')].map((a) => a.textContent)),
      text: await page.$eval('.daily-paragraph', (p) => p.textContent),
    });
    let s = await shown();
    expect(s.decisions).toEqual(['Alpha decision']);
    expect(s.rows).toEqual(['Alpha update']);
    expect(s.paragraph).toEqual(['Alpha decision']); // the paragraph keeps only alpha's entries
    expect(s.text).toMatch(/^1 decision: Alpha decision — About alpha\.$/);
    expect(await page.$eval('[data-label-chip]', (c) => c.textContent)).toBe('alpha');

    // Remembered on this device.
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-label-chip]');
    s = await shown();
    expect(s.decisions).toEqual(['Alpha decision']);

    // Two labels: either.
    await (await page.$('[data-label-filter] button'))!.click();
    await (await page.waitForSelector('[data-label="beta"]'))!.click();
    await page.keyboard.press('Escape');
    await page.waitForSelector('article[data-card="hermes:x:beta-s"]');
    s = await shown();
    expect(s.decisions.sort()).toEqual(['Alpha decision', 'Beta decision']);
    expect(s.rows.sort()).toEqual(['Alpha update', 'Beta signal']);
    expect(await page.$eval('[data-label-chip]', (c) => c.textContent)).toBe('alpha +1');

    // Cleared: everything back.
    await (await page.$('[data-label-clear]'))!.click();
    await page.waitForSelector('article[data-card="goalpath:item:1:ship"]');
    expect(await page.$('[data-label-chip]')).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('pbcp.labels'))).toBeNull();
    expect(errors).toEqual([]);
  });

  it('puts a card about tomorrow under Tomorrow, and marks a decision about a later day under today with its day', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const cal = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'cal' })}`;
    await call('PUT', cardPath('cal:x:agenda'), { auth: cal, body: card('cal:x:agenda', { producer: 'cal', kind: 'artifact', title: 'Tomorrow’s agenda', about: day(1) }) });
    await call('PUT', cardPath('cal:x:table'), { auth: cal, body: card('cal:x:table', { producer: 'cal', title: 'Keep the table?', about: day(3) }) });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const tomorrow = (await page.$('xpath/.//section[@data-section][.//h2[starts-with(., "Tomorrow")]]'))!;
    expect(await titles('xpath/.//section[@data-section][.//h2[starts-with(., "Tomorrow")]]//article')).toEqual(['Tomorrow’s agenda']);
    expect(tomorrow).not.toBeNull();
    const today = await page.$('xpath/.//section[@data-section][.//h2[starts-with(., "Today")]]//article[@data-card="cal:x:table"]');
    const label = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).formatToParts(new Date(`${day(3)}T00:00:00Z`));
    const p = (t: string) => label.find((x) => x.type === t)!.value;
    expect(await today!.$eval('[data-for-day]', (f) => f.textContent)).toBe(`· for ${p('weekday')} ${p('day')} ${p('month')}`);
    expect(await page.$('xpath/.//section[@data-section][.//h2[starts-with(., "Today")]]//article[@data-card="cal:x:agenda"]')).toBeNull();
  });
});

describe('no horizontal overflow', () => {
  it('keeps every card on the screen at phone widths, however long its words: the page never gets wider than the device', async () => {
    const hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', ceiling: 'immediate' })}`;
    const word = 'Supercalifragilistic'.repeat(6); // 120 characters, no break
    const url = `https://example.com/${'a'.repeat(90)}/${'b'.repeat(40)}`;
    const put = (id: string, extra: Record<string, unknown>) => call('PUT', cardPath(id), { auth: hermes, body: card(id, extra) });
    await put('hermes:long:decision', { title: `Decide ${word}`, body: `Lead with ${url} and \`${word}\` in it.\n\n## Proposal\n\n${word}`, labels: ['a-very-long-label-of-32-chars-xx', 'another-long-label-32-characters'], source: { url: `https://${'sub'.repeat(12)}.example.com/x`, label: word } });
    await put('hermes:long:update', { kind: 'artifact', title: word, summary: `${url} ${word}` });
    await put('hermes:long:signal', { kind: 'signal', title: `Signal ${word}`, body: `| ${word} | ${word} |\n| --- | --- |\n| a | b |` });
    await call('POST', `/api/me/cards/${encodeURIComponent('hermes:long:update')}/ack`, { auth: `Session ${session.access_token}` });
    for (const width of [360, 390]) {
      await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('article[data-card="hermes:long:decision"]');
      const r = await page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        // Boxes past the right edge, except inside something that scrolls or clips its own overflow (a table, a pre).
        const contained = (e: Element) => {
          for (let a = e.parentElement; a; a = a.parentElement) if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(a).overflowX) && a !== document.documentElement && a !== document.body) return true;
          return false;
        };
        const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1 && !contained(e)).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}`);
        return { W, scrollW: document.documentElement.scrollWidth, wide: wide.slice(0, 5) };
      });
      expect(r.wide, String(width)).toEqual([]);
      expect(r.scrollW, String(width)).toBe(r.W);
    }
  });
});

describe('theme', () => {
  const scheme = (value: 'light' | 'dark') => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value }]);
  /** Whether the page is dark, by its class and by what is painted. */
  const looks = () =>
    page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), ground: getComputedStyle(document.body).backgroundColor }));
  const choose = async (choice: 'system' | 'light' | 'dark') => {
    await (await page.waitForSelector('[data-theme-menu]'))!.click();
    await (await page.waitForSelector(`[data-theme-choice="${choice}"]`))!.click();
  };

  it('follows a dark scheme before first paint when nothing is saved, and offers System, Light and Dark with System chosen', async () => {
    await scheme('light');
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    const light = await looks();
    await scheme('dark');
    // The first frame's class, from the inline script, before the app has run.
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('DOMContentLoaded', () => ((window as unknown as { firstDark: boolean }).firstDark = document.documentElement.classList.contains('dark')), { once: true });
    });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    expect(await page.evaluate(() => (window as unknown as { firstDark: boolean }).firstDark)).toBe(true);
    const dark = await looks();
    expect(dark.dark).toBe(true);
    expect(dark.ground).not.toBe(light.ground);
    expect(await page.$eval('[data-theme-menu]', (b) => b.getAttribute('aria-label'))).toBe('Theme: System');
    await (await page.$('[data-theme-menu]'))!.click();
    expect(await page.$$eval('[data-theme-choice]', (items) => items.map((i) => [i.textContent, i.getAttribute('aria-checked')]))).toEqual([['System', 'true'], ['Light', 'false'], ['Dark', 'false']]);
  });

  it('keeps a saved Light under a dark scheme, from the first paint and through a scheme change', async () => {
    await page.evaluate(() => localStorage.setItem('pbcp.theme', 'light'));
    await scheme('dark');
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    expect((await looks()).dark).toBe(false);
    await scheme('light');
    await scheme('dark');
    await new Promise((r) => setTimeout(r, 200));
    expect((await looks()).dark).toBe(false);
    expect(await page.$eval('[data-theme-menu]', (b) => b.getAttribute('aria-label'))).toBe('Theme: Light');
  });

  it('under System, follows the scheme as it changes without a reload; a pick stops that, System starts it again, and Settings agrees', async () => {
    await scheme('light');
    await page.goto(`${headUrl()}/settings`, { waitUntil: 'networkidle0' });
    expect((await looks()).dark).toBe(false);
    await scheme('dark');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await scheme('light');
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));

    await choose('dark');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    expect(await page.evaluate(() => localStorage.getItem('pbcp.theme'))).toBe('dark');
    expect(await page.$eval('select[aria-label="Theme"]', (s) => (s as HTMLSelectElement).value)).toBe('dark');
    await scheme('dark');
    await scheme('light');
    await new Promise((r) => setTimeout(r, 200));
    expect((await looks()).dark).toBe(true);

    await page.select('select[aria-label="Theme"]', 'system');
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    expect(await page.evaluate(() => localStorage.getItem('pbcp.theme'))).toBeNull();
    expect(await page.$eval('[data-theme-menu]', (b) => b.getAttribute('aria-label'))).toBe('Theme: System');
    await scheme('dark');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  });
});

describe('settings: the daily brief notification', () => {
  it('is a switch and a quarter-hour time on this device, shown but not changeable for another, and on an iPhone in Safari says to install first', async () => {
    const other = await ownerSession(OWNER, 'phone');
    await call('PATCH', `/api/me/settings/devices/${other.deviceId}`, { auth: other.auth, body: { daily_notification: { enabled: true, time: '06:45' } } });
    await page.goto(`${headUrl()}/settings`, { waitUntil: 'networkidle0' });
    const mine = `[data-daily-notification="${session.device_id}"]`;
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-notify-note]`)?.textContent?.includes('once a day'), {}, mine);
    expect(await page.$eval(`${mine} [data-notify-switch]`, (b) => [b.getAttribute('aria-checked'), (b as HTMLButtonElement).disabled])).toEqual(['false', false]);
    expect(await page.$eval(`${mine} [data-notify-time]`, (t) => [(t as HTMLSelectElement).value, t.querySelectorAll('option').length])).toEqual(['07:00', 96]);
    const theirs = `[data-daily-notification="${other.deviceId}"]`;
    expect(await page.$eval(`${theirs} [data-notify-switch]`, (b) => [b.getAttribute('aria-checked'), (b as HTMLButtonElement).disabled])).toEqual(['true', true]);
    expect(await page.$eval(`${theirs} [data-notify-time]`, (t) => (t as HTMLSelectElement).value)).toBe('06:45');
    expect(await page.$eval(`${theirs} [data-notify-note]`, (n) => n.textContent)).toBe('Set on that device.');

    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-notify-note]`)?.textContent?.includes('Home Screen'), {}, mine);
    expect(await page.$eval(`${mine} [data-notify-switch]`, (b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('settings: renaming a producer', () => {
  it('edits the name in place: Enter saves and it survives a reload, Escape puts it back, blur saves; a nameless one shows its root', async () => {
    await page.goto(`${headUrl()}/settings`, { waitUntil: 'networkidle0' });
    const name = '[data-token="goalpath"] [data-producer-name]';
    await page.waitForSelector(name);
    expect(await page.$eval(name, (b) => b.textContent)).toBe('goalpath'); // minted without a name
    await page.click(name);
    const input = '[data-token="goalpath"] [data-producer-name-input]';
    await page.waitForSelector(input);
    await page.$eval(input, (i) => (i as HTMLInputElement).select());
    await page.type(input, 'Milestones');
    await page.keyboard.press('Enter');
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'Milestones', {}, name);
    expect(await page.$eval('[data-token="goalpath"] [data-root]', (p) => p.textContent)).toBe('Milestones · goalpath');

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector(name);
    expect(await page.$eval(name, (b) => b.textContent)).toBe('Milestones');

    await page.click(name);
    await page.waitForSelector(input);
    await page.type(input, ' and more');
    await page.keyboard.press('Escape');
    await page.waitForSelector(name);
    expect(await page.$eval(name, (b) => b.textContent)).toBe('Milestones');

    await page.click(name);
    await page.waitForSelector(input);
    await page.$eval(input, (i) => (i as HTMLInputElement).select());
    await page.type(input, 'GoalPath');
    await page.click('[data-section-settings="producers"] h3'); // leaving the field saves
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'GoalPath', {}, name);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector(name);
    expect(await page.$eval(name, (b) => b.textContent)).toBe('GoalPath');
  });
});

describe('settings at phone widths', () => {
  it('keeps every section on the screen, with nothing scrolling sideways, and a paired producer’s root on one line', async () => {
    const auth = `Session ${session.access_token}`;
    await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', instance: 'mac-mini-in-the-office', executor: true });
    const c = (await call('POST', '/api/me/settings/pairing', { auth })).body;
    await call('POST', '/api/pair', { body: { code: c.code, root: 'n8n', name: 'n8n on MacBook Pro of the kitchen table' }, headers: { 'x-real-ip': '203.0.113.77' } });
    for (const width of [360, 390]) {
      await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`${headUrl()}/settings`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-token="n8n"] [data-paired]');
      const r = await page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        // No exemption for boxes that scroll, except a code snippet: a settings row that needs sideways scrolling is the bug.
        const wide = [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > W + 1).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}`);
        const scrollers = [...document.querySelectorAll('main *')].filter((e) => e.tagName !== 'PRE' && e.scrollWidth > e.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX)).map((e) => e.tagName);
        const root = document.querySelector('[data-token="n8n"] [data-root]')!;
        const line = parseFloat(getComputedStyle(root).lineHeight);
        return { W, scrollW: document.documentElement.scrollWidth, wide: wide.slice(0, 5), scrollers, rootLines: Math.round(root.getBoundingClientRect().height / line) };
      });
      expect(r.wide, String(width)).toEqual([]);
      expect(r.scrollers, String(width)).toEqual([]);
      expect(r.scrollW, String(width)).toBe(r.W);
      expect(r.rootLines, String(width)).toBe(1);
    }
    await page.setViewport({ width: 1280, height: 844 });
  });
});

describe('iPhone Safari', () => {
  it('gets 16px text in every field on a touch screen, so focusing one never zooms the page; the masthead and day headers are opaque', async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-day]');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    for (const path of ['/orders', '/settings']) {
      await page.goto(`${headUrl()}${path}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('textarea, input');
      const sizes = await page.$$eval('input, textarea, select', (fs) => fs.map((f) => parseFloat(getComputedStyle(f).fontSize)));
      expect(sizes.length, path).toBeGreaterThan(0);
      expect(sizes.filter((x) => x < 16), path).toEqual([]);
    }
    await page.goto(`${headUrl()}/brief`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-day]');
    const alpha = (sel: string) => page.$eval(sel, (e) => {
      const c = getComputedStyle(e).backgroundColor;
      const m = /rgba?\(([^)]+)\)|color\([^ ]+ [^ ]+ [^ ]+ [^ /]+(?: \/ ([\d.]+))?\)/.exec(c)!;
      const parts = m[1]?.split(',') ?? [];
      return parts.length === 4 ? Number(parts[3]) : m[2] !== undefined ? Number(m[2]) : 1;
    });
    expect(await alpha('[data-masthead]')).toBe(1);
    expect(await page.$eval('[data-day]', (h) => getComputedStyle(h).position)).toBe('sticky');
    expect(await alpha('[data-day]')).toBe(1);
  });
});

describe('a producer’s table on a phone', () => {
  it('keeps prices and headings whole and scrolls sideways in its own box, never widening the page', async () => {
    const n8n = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'n8n' })}`;
    const rows = [
      ['[SuperSix EVO 2 · Mike’s Bikes (Tungsten Blue) (sold out)](https://mikesbikes.example/a)', '$5,599.95', '$5,599.95', '$5,599.95', '—'],
      ['[SuperSix EVO 3 · Bike Attack (all sizes)](https://bikeattack.example/b)', '$6,999', '$6,999', '$6,999', '−$300'],
    ];
    const body = ['## Bikes (size 56)', '', '| Item | Today | Yesterday | 30-day low | Change |', '| --- | ---: | ---: | ---: | ---: |', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
    await call('PUT', cardPath('n8n:prices:1'), { auth: n8n, body: card('n8n:prices:1', { kind: 'artifact', title: 'Prices · Tue 27 Oct', body }) });
    await until(async () => (await row('n8n:prices:1')).renderedHtml !== null);
    for (const width of [360, 390]) {
      await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`${headUrl()}/card/${encodeURIComponent('n8n:prices:1')}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.rendered table');
      const r = await page.evaluate(() => {
        const table = document.querySelector<HTMLElement>('.rendered table')!;
        // Lines of a cell's text: the distinct tops of its rendered line boxes.
        const line = (e: Element) => {
          const range = document.createRange();
          range.selectNodeContents(e);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        };
        const cells = [...table.querySelectorAll('th, td')].filter((c) => !c.querySelector('a') && c.textContent!.trim() !== 'Item');
        return {
          pageFits: document.documentElement.scrollWidth === document.documentElement.clientWidth,
          tableInCard: table.getBoundingClientRect().right <= document.documentElement.clientWidth,
          scrolls: getComputedStyle(table).overflowX,
          multiLine: cells.filter((c) => line(c) > 1).map((c) => c.textContent),
          rightAligned: getComputedStyle(table.querySelector('td:nth-child(2)')!).textAlign,
        };
      });
      expect(r, String(width)).toEqual({ pageFits: true, tableInCard: true, scrolls: 'auto', multiLine: [], rightAligned: 'right' });
    }
  });
});

describe('one masthead', () => {
  /** The masthead's shared parts, with the ids Radix generates per render taken out, and its height. */
  const shared = () =>
    page.evaluate(() => {
      const parts = [...document.querySelectorAll('[data-masthead-shared]')].map((e) => {
        const c = e.cloneNode(true) as Element;
        for (const el of [c, ...c.querySelectorAll('*')]) for (const a of ['id', 'aria-controls', 'aria-labelledby', 'aria-describedby']) el.removeAttribute(a);
        return c.outerHTML;
      });
      return { parts, height: document.querySelector('[data-masthead]')!.getBoundingClientRect().height, row: document.querySelector('[data-masthead-row]')!.getBoundingClientRect() };
    });

  for (const width of [390, 1280]) {
    it(`is the same on the brief, a card and orders at ${width} px: name, dateline, tools; only the row under the name differs`, async () => {
      await page.setViewport({ width, height: 844 });
      const seen: Array<Awaited<ReturnType<typeof shared>>> = [];
      for (const path of ['/brief', `/card/${encodeURIComponent('goalpath:item:1:ship')}`, '/orders']) {
        await page.goto(`${headUrl()}${path}`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => document.querySelector('[data-dateline]')?.textContent);
        seen.push(await shared());
      }
      expect(seen[0]!.parts).toHaveLength(3); // the name, the dateline, the tools
      expect(seen[0]!.parts.join('')).toContain('>Brief</h1>');
      for (const s of seen.slice(1)) {
        expect(s.parts).toEqual(seen[0]!.parts);
        expect(s.height).toBeCloseTo(seen[0]!.height, 0);
        expect(s.row).toEqual(seen[0]!.row); // the row is where it is, the same size, on every route
      }
      // The brief's row is its week strip; the others' is the way back and the page's title.
      await page.goto(`${headUrl()}/orders`, { waitUntil: 'networkidle0' });
      expect(await page.$eval('[data-masthead-row]', (r) => r.textContent)).toBe('← BriefOrders');
      expect(await page.$('[data-masthead-row] nav[aria-label="Week"]')).toBeNull();
      expect(await page.$$eval('[data-masthead]', (ms) => ms.length)).toBe(1);
    });
  }

  it('dates the masthead with the time of day in words, on the device’s clock and timezone', async () => {
    await page.emulateTimezone('America/New_York');
    for (const [local, word] of [['2026-10-27T08:15:00-04:00', 'morning'], ['2026-10-27T13:00:00-04:00', 'afternoon'], ['2026-10-27T19:45:00-04:00', 'evening']] as const) {
      const context = page.browserContext();
      const p = await context.newPage();
      await p.emulateTimezone('America/New_York');
      // The device's clock, fixed: new Date() and Date.now() say `local`.
      await p.evaluateOnNewDocument((ms: number) => {
        const Real = Date;
        class Fixed extends Real {
          constructor(...a: unknown[]) {
            super(...((a.length ? a : [ms]) as [number]));
          }
          static override now() {
            return ms;
          }
        }
        globalThis.Date = Fixed as DateConstructor;
      }, Date.parse(local));
      await p.goto(`${headUrl()}/orders`, { waitUntil: 'networkidle0' });
      await p.waitForFunction(() => document.querySelector('[data-dateline]')?.textContent);
      expect(await p.$eval('[data-dateline]', (d) => d.textContent)).toBe(`Tue 27 Oct · ${word}`);
      await p.close();
    }
  });
});

describe('the card page', () => {
  it('shows the card as the brief does, body open, then its decision log as a table', async () => {
    const id = 'goalpath:item:1:ship';
    await call('POST', `/api/me/cards/${encodeURIComponent(id)}/decision`, { auth: `Session ${session.access_token}`, body: { decision: 'ship-next', comment: 'After the review.' } });
    await page.goto(`${headUrl()}/card/${encodeURIComponent(id)}`, { waitUntil: 'networkidle0' });
    const article = (await page.waitForSelector(`[data-card-page] article[data-card="${id}"][data-kind="decision"]`))!;
    expect(await article.$('.more-trigger')).toBeNull(); // no "More": the body is open
    expect(await page.$eval('[data-masthead-row]', (r) => r.textContent)).toBe('← BriefDecision');
    const rows = await page.$$eval('[data-decision-log] tbody tr', (rs) => rs.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent)));
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toBe('ship-next“After the review.”');
    expect(rows[0]![2]).toBe('browser'); // the device that recorded it, by name
  });
});

describe('settings', () => {
  it('shows the sections in order, mints a token shown once and filled into the snippets, and is under the shared masthead', async () => {
    await page.goto(`${headUrl()}/settings`, { waitUntil: 'networkidle0' });
    expect(await page.$$eval('[data-section-settings]', (ss) => ss.map((s) => s.getAttribute('data-section-settings')))).toEqual(['this-head', 'producers', 'connect', 'devices', 'preferences']);
    expect(await page.$eval('[data-masthead-row]', (r) => r.textContent)).toBe('← BriefSettings');
    expect(await page.$eval('[data-pairing]', (p) => p.textContent)).toContain('six characters shown as two groups of three (XXX-XXX); the dash is optional when entering');
    expect(await page.$eval('[data-value="owner id"]', (v) => v.textContent)).toBe(OWNER);
    expect(await page.$eval('[data-value="head URL"]', (v) => v.textContent)).toBe(`${headUrl()}/api`);
    expect(await page.$eval('[data-this-device]', (d) => d.closest('[data-device]')!.textContent)).toContain('browser');

    await page.type('input[aria-label="New producer’s root"]', 'n8n');
    await (await page.$('xpath/.//button[.="New producer"]'))!.click();
    await page.waitForSelector('[data-minted]');
    const token = (await page.$eval('[data-minted] [data-snippet="token"]', (t) => t.textContent))!;
    expect(token).toMatch(/^pbcp_/);
    expect(await page.$eval('[data-minted]', (m) => m.textContent)).toContain('This is the only time it is shown');
    await page.waitForFunction((t) => document.querySelector('[data-snippet="curl"]')?.textContent?.includes(t), {}, token);
    await page.waitForFunction(() => document.querySelector('[data-producer-tokens]')?.textContent?.includes('n8n'));

    await page.reload({ waitUntil: 'networkidle0' });
    expect(await page.$('[data-minted]')).toBeNull();
    expect(await page.content()).not.toContain(token); // never shown again
    expect(await page.$eval('[data-snippet="curl"]', (c) => c.textContent)).toContain('<token>');
    expect(errors).toEqual([]);
  });

  it('shows the same curl as /connect, with the token just minted in place of <token>', async () => {
    await page.goto(`${headUrl()}/connect`, { waitUntil: 'networkidle0' });
    const pub = (await page.$eval('[data-snippet="curl"]', (c) => c.textContent))!;
    expect(pub).toContain('Bearer <token>');
    await page.goto(`${headUrl()}/settings`, { waitUntil: 'networkidle0' });
    await page.type('input[aria-label="New producer’s root"]', 'hermes'); // the §3 example's root: the same card
    await (await page.$('xpath/.//button[.="New producer"]'))!.click();
    const token = (await (await page.waitForSelector('[data-minted] [data-snippet="token"]'))!.evaluate((t) => t.textContent))!;
    await page.waitForFunction((t) => document.querySelector('[data-snippet="curl"]')?.textContent?.includes(t), {}, token);
    expect(await page.$eval('[data-snippet="curl"]', (c) => c.textContent)).toBe(pub.split('<token>').join(token));
    expect(await page.$eval('[data-value="PBCP_TOKEN"]', (c) => c.textContent)).toBe(token);
  });
});

describe('OAuth consent', () => {
  it('asks a signed-out owner to sign in first, then names the app and what it may do, and Allow sends the code back', async () => {
    const reg = await (await fetch(`${headUrl()}/api/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.example/api/mcp/auth_callback'] }) })).json();
    const auth = new URL(`${headUrl()}/api/oauth/authorize`);
    const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.example/api/mcp/auth_callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 'xyz', scope: 'owner' };
    for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v);

    // Signed out: to sign-in, which would bring the owner back.
    const out = await (await browser.createBrowserContext()).newPage();
    await out.goto(auth.href, { waitUntil: 'networkidle0' });
    expect(new URL(out.url()).pathname).toBe('/signin');
    expect(new URL(out.url()).searchParams.get('next')).toMatch(/^\/oauth\/consent\?request=/);
    await out.browserContext().close();

    // Signed in (the page's session): the app's name, the sentence, where it returns.
    await page.goto(auth.href, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-consent]');
    expect(await page.$eval('[data-client-name]', (e) => e.textContent)).toBe('Claude');
    expect(await page.$eval('[data-consent]', (e) => e.textContent)).toContain('Allow this app to read your brief and record your decisions.');
    expect(await page.$eval('[data-consent]', (e) => e.textContent)).toContain('claude.example');
    await page.setRequestInterception(true);
    let back = '';
    const intercept = (r: HTTPRequest) => {
      if (!r.url().startsWith('https://claude.example/')) return void r.continue();
      if (r.url().startsWith('https://claude.example/api/mcp/auth_callback')) back = r.url();
      void r.respond({ status: 200, body: 'ok' });
    };
    page.on('request', intercept);
    await (await page.$('[data-allow]'))!.click();
    await until(async () => back !== '');
    const u = new URL(back);
    expect(u.searchParams.get('state')).toBe('xyz');
    expect(u.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    page.off('request', intercept);
    await page.setRequestInterception(false);

    // A request whose payload was altered (a name and a return address of the attacker's choosing): nothing from it is
    // shown, because the page shows only what the head verified.
    const signed = new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location')!).searchParams.get('request')!;
    const [h, body, sig] = signed.split('.');
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const forged = { ...claims, req: { ...claims.req, client_name: 'Totally Your Bank', redirect_uri: 'https://attacker.example/cb' } };
    await page.goto(`${headUrl()}/oauth/consent?request=${[h, Buffer.from(JSON.stringify(forged)).toString('base64url'), sig].join('.')}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[role="alert"]');
    expect(await page.$('[data-consent]')).toBeNull();
    const text = await page.$eval('body', (b) => b.textContent ?? '');
    expect(text).toContain('This request cannot be used.');
    expect(text).not.toMatch(/Totally Your Bank|attacker\.example/);
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
    expect(await page.$$eval('[data-order-table] tr', (rs) => rs.map((r) => [r.querySelector('th')!.textContent, r.querySelector('td')!.textContent]))).toEqual(
      expect.arrayContaining([['State', 'claimed'], ['Held by', 'hermes']]),
    );
    expect(text).toContain('Order and progress');
    expect(text).toContain('1 earlier updates'); // four updates: one folded, the latest three shown
    await (await page.$('xpath/.//button[.="Cancel order"]'))!.click();
    await page.waitForSelector('.toast');
    await until(async () => (await row(order!.id)).execState === 'cancelled');
    expect((await row(order!.id)).state).toBe('decided');
    expect(errors).toEqual([]);
  });
});
