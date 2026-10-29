// The front door (app/about, GET / for a browser): the page, its demo brief (lib/demo, the demo cards replayed in memory,
// nothing stored, no signed-in data), and its invite requests (POST /api/invite, Settings → Invite requests).

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cards, inviteRequests } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { DEMO_TIMEZONE } from '../../lib/demo/replay';
import { demoScenario } from '../../lib/demo/scenario';
import { localDate } from '../../lib/time';
import { card, cardPath } from './cards';
import { ensureHead } from '../../lib/heads';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

const BROWSER = 'text/html,application/xhtml+xml,*/*;q=0.8';
const page = async () => (await call('GET', '/', { headers: { accept: BROWSER } })).body as string;
/** What the page shows: its markup without the inline script payloads Next.js hydrates from. */
const shown = (html: string) => html.replace(/<script\b[\s\S]*?<\/script>/g, '');
const invite = (body: unknown, headers: Record<string, string> = {}) => call('POST', '/api/invite', { body, headers: { 'x-real-ip': address, ...headers } });
let address = '';
let ip = 0;

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { rateLimits: null } });
  address = `203.0.113.${++ip}`;
});
afterEach(() => call('POST', '/api/test', { body: { rateLimits: null } }));

describe('the front door', () => {
  it('shows the demo cards in its brief, rendered, and nothing of the head’s own', async () => {
    const hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
    await call('PUT', cardPath('hermes:mail:secret'), { auth: hermes, body: card('hermes:mail:secret', { title: 'A private card on this head' }) });
    const html = await page();
    // Every decision the demo leaves open (one the owner decides in it is not in today's list).
    const steps = demoScenario(localDate(new Date(), DEMO_TIMEZONE), DEMO_TIMEZONE); // the page's day: the demo head's, by the wall clock
    const decided = new Set(steps.flatMap((s) => ('decide' in s ? [s.decide] : [])));
    const titles = steps.flatMap((s) => ('put' in s && s.card.kind === 'decision' && !decided.has(s.card.id) ? [s.card.title] : []));
    expect(titles.length).toBeGreaterThan(4);
    for (const t of titles) expect(html, t).toContain(t.replace(/&/g, '&amp;').replace(/'/g, '&#x27;'));
    expect(html).toContain('data-hero-brief');
    // Leads as the head renders them, in the markup itself.
    expect(shown(html)).toContain('Anna wants to pay the September invoice on the 20th instead of the 15th');
    // Today's schedule: the calendar's timed cards on the rail, and the moved call, which the brief presents, as a
    // marker that links to its row there (§4.5, §8).
    expect(shown(html)).toContain('data-schedule');
    expect(shown(html)).toMatch(/data-rail-entry="cal:demo:standup-\d{8}"/);
    expect(shown(html)).toMatch(/href="#brief-cal:demo:3f9a0c1d2e4b5a69-\d{8}T1600Z:moved"[^>]*data-marker=/);
    expect(html).not.toContain('A private card on this head');
    expect(html).not.toContain(`>${OWNER}<`);
    // Replaying the demo stores nothing: no card rows but the one PUT above.
    expect((await testDb().select({ id: cards.id }).from(cards)).map((c) => c.id)).toEqual(['hermes:mail:secret']);
  });

  it('says the hosted head is invite-only, links the self-hosting guide, and names the protocol once', async () => {
    const html = await page();
    expect(html).toContain('Invite only');
    expect(html).toContain('href="https://github.com/morkeleb/pbcp-head/blob/main/docs/deploy.md"');
    expect(html).toContain('action="/api/invite"');
    expect(shown(html).match(/built on the(?:(?!<\/p>)[\s\S]){0,400}?Personal Brief Card Protocol/gi)).toHaveLength(1);
  });
});

describe('POST /api/invite', () => {
  it('stores an address once, with its browser, and answers 202', async () => {
    let r = await invite({ email: 'anna@example.com' }, { 'user-agent': 'TestBrowser/1' });
    expect([r.status, r.body]).toEqual([202, { requested: true }]);
    r = await invite({ email: 'ANNA@example.com' });
    expect(r.status).toBe(202);
    const rows = await testDb().select().from(inviteRequests);
    expect(rows).toEqual([expect.objectContaining({ email: 'anna@example.com', userAgent: 'TestBrowser/1' })]);
  });

  it('refuses what is not an email address, and any credential', async () => {
    for (const email of ['', 'not-an-address', 'a@b', `${'x'.repeat(250)}@example.com`, 42]) {
      address = `203.0.113.${++ip}`; // each from its own address, under the rate limit
      const r = await invite({ email });
      expect([r.status, r.body.error], JSON.stringify(email)).toEqual([400, 'invalid_email']);
    }
    const owner = await ownerSession();
    const hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
    for (const auth of [owner.auth, hermes]) {
      const r = await call('POST', '/api/invite', { auth, body: { email: 'b@example.com' }, headers: { 'x-real-ip': address } });
      expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
    }
    expect(await testDb().select().from(inviteRequests)).toEqual([]);
  });

  it('takes the form without JavaScript and sends the browser back to the front door', async () => {
    const r = await fetch(`${headUrl()}/api/invite`, { method: 'POST', body: 'email=c%40example.com', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': address }, redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/?invite=requested#invite');
    expect((await testDb().select().from(inviteRequests).where(eq(inviteRequests.email, 'c@example.com')))).toHaveLength(1);
    expect(await (await call('GET', '/?invite=requested', { headers: { accept: BROWSER } })).body).toContain('your request is in');
  });

  it('is rate-limited per address with 429 rate_limited', async () => {
    await call('POST', '/api/test', { body: { rateLimits: { invite: 2 } } });
    expect((await invite({ email: 'd1@example.com' })).status).toBe(202);
    expect((await invite({ email: 'd2@example.com' })).status).toBe(202);
    const r = await invite({ email: 'd3@example.com' });
    expect([r.status, r.body.error]).toEqual([429, 'rate_limited']);
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    address = '198.51.100.9';
    expect((await invite({ email: 'd3@example.com' })).status).toBe(202);
  });
});

describe('Settings → Invite requests', () => {
  it('lists the requests for the deployment’s own head, deletes one, and refuses another head', async () => {
    await invite({ email: 'e1@example.com' }, { 'user-agent': 'UA' });
    await invite({ email: 'e2@example.com' });
    const owner = await ownerSession();
    const list = (await call('GET', '/api/me/settings/invites', { auth: owner.auth })).body.requests;
    expect(list).toEqual([
      { id: expect.any(String), email: 'e1@example.com', created_at: expect.any(String), user_agent: 'UA' },
      { id: expect.any(String), email: 'e2@example.com', created_at: expect.any(String), user_agent: expect.any(String) },
    ]);
    expect((await call('DELETE', `/api/me/settings/invites/${list[0].id}`, { auth: owner.auth })).status).toBe(204);
    expect((await call('GET', '/api/me/settings/invites', { auth: owner.auth })).body.requests.map((r: { email: string }) => r.email)).toEqual(['e2@example.com']);
    let r = await call('DELETE', `/api/me/settings/invites/${list[0].id}`, { auth: owner.auth });
    expect([r.status, r.body.error]).toEqual([404, 'not_found']);
    // A second head on the deployment: the requests are not its to see.
    await ensureHead(testDb(), 'anna');
    const other = await ownerSession('anna');
    r = await call('GET', '/api/me/settings/invites', { auth: other.auth });
    expect([r.status, r.body.error]).toEqual([403, 'not_the_operator']);
  });
});
