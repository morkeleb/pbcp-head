import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cards, diagrams } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

let hermes: string;
let owner: { auth: string; deviceId: string };
const clock = (at: string) => call('POST', '/api/test', { body: { clock: at } });
const put = (id: string, extra: Record<string, unknown> = {}, auth = hermes) => call('PUT', cardPath(id), { auth, body: card(id, extra) });
const me = (method: string, path: string, body?: unknown) => call(method, path, { auth: owner.auth, ...(body !== undefined ? { body } : {}) });
const ids = (list: Array<{ id: string }>) => list.map((c) => c.id);

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z', syncPageSize: null } });
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes', ceiling: 'immediate' })}`;
  owner = await ownerSession();
});

describe('GET /api/me/brief', () => {
  it('lists open decisions newest first, without decided or snoozed ones', async () => {
    await clock('2026-10-07T07:00:00Z');
    await put('hermes:gmail:old');
    await clock('2026-10-07T08:00:00Z');
    await put('hermes:gmail:new');
    await put('hermes:gmail:decided');
    await put('hermes:gmail:snoozed');
    await clock('2026-10-07T09:00:00Z');
    await me('POST', `/api/me/cards/${encodeURIComponent('hermes:gmail:decided')}/decision`, { decision: 'approve' });
    await me('POST', `/api/me/cards/${encodeURIComponent('hermes:gmail:snoozed')}/snooze`, { preset: 'tomorrow' });
    const b = (await me('GET', '/api/me/brief')).body;
    expect(ids(b.decisions)).toEqual(['hermes:gmail:new', 'hermes:gmail:old']);
    expect(b.snoozed).toBe(1);
    expect(b.decisions[0].rendered_html).toContain('<h2>Proposal</h2>');
    expect(b).toMatchObject({ date: '2026-10-07', timezone: 'UTC', daily: null, last_visit: { seq: 0, at: null } });
  });

  it("folds today's artifacts and signals by thread, immediate first, leaving log and yesterday's out", async () => {
    await clock('2026-10-06T20:00:00Z');
    await put('hermes:gmail:yesterday', { kind: 'artifact' });
    await clock('2026-10-07T06:00:00Z');
    await put('hermes:gmail:a1', { kind: 'artifact', thread: 'gmail:t1', title: 'First in thread' });
    await put('hermes:gmail:a2', { kind: 'signal', thread: 'gmail:t1', title: 'Second in thread' });
    await put('hermes:gmail:quiet', { kind: 'signal', urgency: 'log' });
    await put('hermes:gmail:loud', { kind: 'signal', urgency: 'immediate' });
    const b = (await me('GET', '/api/me/brief')).body;
    expect(b.threads.map((t: { latest: { id: string }; count: number }) => [t.latest.id, t.count])).toEqual([['hermes:gmail:loud', 1], ['hermes:gmail:a2', 2]]);
    expect(b.threads[1]).toMatchObject({ producer: 'hermes', thread: 'gmail:t1', cards: [{ id: 'hermes:gmail:a1' }, { id: 'hermes:gmail:a2' }] });
  });

  it('clamps by the ceiling for delivery: an immediate card from a brief-ceiling producer is not put first', async () => {
    const quiet = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'cal' })}`;
    await put('hermes:gmail:b', { kind: 'signal' });
    await put('cal:event:1', { kind: 'signal', urgency: 'immediate' }, quiet);
    const b = (await me('GET', '/api/me/brief')).body;
    expect(b.threads.map((t: { latest: { id: string } }) => t.latest.id)).toEqual(['cal:event:1', 'hermes:gmail:b']); // newest first, no immediate jump
  });

  it('marks what changed since the last visit; visiting moves the cursor forward only', async () => {
    await put('hermes:gmail:1');
    const first = (await me('GET', '/api/me/brief')).body;
    expect(first.new).toEqual(['hermes:gmail:1']);
    expect((await me('POST', '/api/me/visit', { seq: first.seq })).body).toMatchObject({ seq: first.seq, at: '2026-10-07T09:00:00Z' });
    await put('hermes:gmail:2');
    const second = (await me('GET', '/api/me/brief')).body;
    expect(second.new).toEqual(['hermes:gmail:2']);
    expect(second.last_visit.seq).toBe(first.seq);
    expect((await me('POST', '/api/me/visit', { seq: 0 })).body.seq).toBe(first.seq);
    expect((await me('POST', '/api/me/visit', { seq: 10_000 })).body.seq).toBe(second.seq);
    expect((await me('POST', '/api/me/visit', { seq: -1 })).status).toBe(400);
  });
});

describe('GET /api/me/cards', () => {
  it("lists a local day in the head's timezone, in change_seq order, paginated", async () => {
    expect((await me('PATCH', '/api/me/settings', { timezone: 'Europe/Copenhagen' })).body.timezone).toBe('Europe/Copenhagen');
    await clock('2026-10-06T21:30:00Z'); // 23:30 on the 6th in Copenhagen
    await put('hermes:gmail:late');
    await clock('2026-10-06T22:30:00Z'); // 00:30 on the 7th
    for (const n of [1, 2, 3]) await put(`hermes:gmail:d${n}`);
    const page1 = (await me('GET', '/api/me/cards?date=2026-10-07&limit=2')).body;
    expect(ids(page1.cards)).toEqual(['hermes:gmail:d1', 'hermes:gmail:d2']);
    expect(page1.cards[0].rendered_html).toBeTruthy();
    const page2 = (await me('GET', `/api/me/cards?date=2026-10-07&limit=2&after=${page1.next}`)).body;
    expect(ids(page2.cards)).toEqual(['hermes:gmail:d3']);
    expect(page2.next).toBeNull();
    expect(ids((await me('GET', '/api/me/cards?date=2026-10-06')).body.cards)).toEqual(['hermes:gmail:late']);
  });

  it('filters by state and refuses malformed queries', async () => {
    await put('hermes:gmail:1');
    await put('hermes:gmail:2');
    await me('POST', `/api/me/cards/${encodeURIComponent('hermes:gmail:2')}/decision`, { decision: 'reject' });
    expect(ids((await me('GET', '/api/me/cards?state=decided')).body.cards)).toEqual(['hermes:gmail:2']);
    for (const q of ['date=2026-13-01', 'state=maybe', 'since=yesterday', 'after=-3']) expect((await me('GET', `/api/me/cards?${q}`)).status).toBe(400);
  });
});

describe('GET /api/me/cards/{id}', () => {
  it('returns the card with its supersession chain, references and thread', async () => {
    await put('hermes:gmail:1', { thread: 't' });
    await put('hermes:gmail:1:v2', { thread: 't', supersedes: 'hermes:gmail:1' });
    await put('hermes:gmail:1:v3', { thread: 't', supersedes: 'hermes:gmail:1:v2', references: ['hermes:gmail:other', 'goalpath:item:9'] });
    await put('hermes:gmail:other', { kind: 'artifact' });
    const r = (await me('GET', `/api/me/cards/${encodeURIComponent('hermes:gmail:1:v2')}`)).body;
    expect(r.card).toMatchObject({ id: 'hermes:gmail:1:v2', state: 'superseded', rendered_html: expect.any(String) });
    expect(ids(r.predecessors)).toEqual(['hermes:gmail:1']);
    expect(ids(r.successors)).toEqual(['hermes:gmail:1:v3']);
    expect(ids(r.thread)).toEqual(['hermes:gmail:1', 'hermes:gmail:1:v2', 'hermes:gmail:1:v3']);
    const v3 = (await me('GET', `/api/me/cards/${encodeURIComponent('hermes:gmail:1:v3')}`)).body;
    expect(v3.references).toEqual([{ id: 'hermes:gmail:other', card: expect.objectContaining({ title: 'Card hermes:gmail:other' }) }, { id: 'goalpath:item:9', card: null }]);
    expect(ids(v3.predecessors)).toEqual(['hermes:gmail:1', 'hermes:gmail:1:v2']);
    expect((await me('GET', `/api/me/cards/${encodeURIComponent('hermes:gmail:nope')}`)).status).toBe(404);
  });

  it('carries rendered choice-option bodies', async () => {
    await put('hermes:gmail:choice', { actions: [{ id: 'friday', label: 'Friday', body: 'Needs **Anna**.', default: true }, 'edit'] });
    const r = (await me('GET', `/api/me/cards/${encodeURIComponent('hermes:gmail:choice')}`)).body;
    expect(r.card.rendered_actions).toEqual({ friday: '<p>Needs <strong>Anna</strong>.</p>' });
  });
});

describe('POST /api/me/cards/{id}/snooze', () => {
  it("snoozes to a preset in the head's timezone, bumps change_seq, and unsnoozes with null", async () => {
    await me('PATCH', '/api/me/settings', { timezone: 'Europe/Copenhagen' });
    const { body: c } = await put('hermes:gmail:1');
    const r = await me('POST', `/api/me/cards/${encodeURIComponent('hermes:gmail:1')}/snooze`, { preset: 'tomorrow' });
    expect(r.body).toMatchObject({ state: 'open', snoozed_until: '2026-10-08T03:30:00Z' });
    expect(r.body.change_seq).toBeGreaterThan(c.change_seq);
    const sync = await call('GET', `/api/changes?after=${c.change_seq}`, { auth: hermes });
    expect(sync.body.changes[0].card.snoozed_until).toBe('2026-10-08T03:30:00Z');
    const un = await me('POST', `/api/me/cards/${encodeURIComponent('hermes:gmail:1')}/snooze`, { until: null });
    expect(un.body).not.toHaveProperty('snoozed_until');
  });

  it('refuses an until that is not a UTC timestamp later than now with 400 invalid_snooze, changing nothing', async () => {
    const { body: c } = await put('hermes:gmail:1');
    const path = `/api/me/cards/${encodeURIComponent('hermes:gmail:1')}/snooze`;
    // The head clock is 2026-10-07T09:00:00Z.
    for (const until of ['soon', '2026-10-07T09:00:00Z', '2026-10-06T12:00:00Z', '2026-10-08T06:00:00+02:00', '2026-02-30T06:00:00Z', 42, undefined]) {
      expect(await me('POST', path, until === undefined ? {} : { until }), String(until)).toMatchObject({ status: 400, body: { error: 'invalid_snooze' } });
    }
    expect((await me('POST', path, { preset: 'someday' })).status).toBe(400);
    expect((await me('GET', `/api/me/cards/${encodeURIComponent('hermes:gmail:1')}`)).body.card.change_seq).toBe(c.change_seq);
  });

  it('unsnoozes on /unsnooze with a fresh change_seq; unsnoozing a card that is not snoozed changes nothing', async () => {
    const { body: c } = await put('hermes:gmail:1');
    const id = encodeURIComponent('hermes:gmail:1');
    const s = await me('POST', `/api/me/cards/${id}/snooze`, { until: '2026-10-08T06:00:00Z' });
    expect(s.body).toMatchObject({ state: 'open', snoozed_until: '2026-10-08T06:00:00Z' });
    const un = await me('POST', `/api/me/cards/${id}/unsnooze`);
    expect(un.status).toBe(200);
    expect(un.body).not.toHaveProperty('snoozed_until');
    expect(un.body.change_seq).toBe(s.body.change_seq + 1);
    const again = await me('POST', `/api/me/cards/${id}/unsnooze`);
    expect(again.body.change_seq).toBe(un.body.change_seq);
    expect(c.change_seq).toBeLessThan(s.body.change_seq);
    expect((await call('POST', `/api/me/cards/${id}/unsnooze`, { auth: hermes })).status).toBe(401);
    expect((await me('POST', `/api/me/cards/${encodeURIComponent('hermes:gmail:none')}/unsnooze`)).status).toBe(404);
  });

  it('does not snooze or unsnooze a decided card: 409 with the stored card', async () => {
    await put('hermes:gmail:1');
    const id = encodeURIComponent('hermes:gmail:1');
    await me('POST', `/api/me/cards/${id}/decision`, { decision: 'approve' });
    expect(await me('POST', `/api/me/cards/${id}/snooze`, { preset: 'tonight' })).toMatchObject({ status: 409, body: { id: 'hermes:gmail:1', state: 'decided' } });
    expect(await me('POST', `/api/me/cards/${id}/unsnooze`)).toMatchObject({ status: 409, body: { state: 'decided' } });
    expect(await me('POST', `/api/me/cards/${id}/snooze`, { until: null })).toMatchObject({ status: 409, body: { state: 'decided' } });
  });
});

describe('GET /api/me/svg/{hash}', () => {
  it('serves a diagram with the size its viewBox gives, so a viewer can start from it', async () => {
    const hash = 'a'.repeat(64);
    await testDb().insert(diagrams).values({ hash, type: 'gantt', svg: '<svg id="d" width="100%" viewBox="0 0 784 196" style="max-width: 784px;" xmlns="http://www.w3.org/2000/svg"><g/></svg>' }).onConflictDoNothing();
    const r = await fetch(`${headUrl()}/api/me/svg/${hash}`);
    const svg = await r.text();
    expect(svg).toMatch(/^<svg width="784" height="196" id="d" viewBox="0 0 784 196"/);
    expect(svg).not.toContain('width="100%"');
  });
});

describe('timezone and settings', () => {
  const zone = (auth: string, tz: string, path = '/api/me') => call('GET', path, { auth, headers: { 'x-timezone': tz } });
  const settings = async () => (await me('GET', '/api/me/settings')).body;

  it('takes the zone from the device most recently seen; UTC before any device has said', async () => {
    expect(await settings()).toEqual({ head: OWNER, display_name: null, timezone: 'UTC', timezone_source: 'default', timezone_override: null, device_timezone: null });
    const phone = await ownerSession(OWNER, 'phone');
    expect((await zone(phone.auth, 'america/denver')).status).toBe(200); // stored in its canonical spelling
    expect(await settings()).toMatchObject({
      timezone: 'America/Denver', timezone_source: 'device', timezone_override: null,
      device_timezone: { device_id: phone.deviceId, timezone: 'America/Denver', seen_at: '2026-10-07T09:00:00Z' },
    });
    // Another device is used later: it is the active one now. Requests without the header change nothing.
    await call('POST', '/api/test', { body: { clock: '2026-10-07T09:05:00Z' } });
    await zone(owner.auth, 'Europe/Stockholm', '/api/me/brief');
    await call('GET', '/api/me', { auth: phone.auth });
    expect((await settings()).timezone).toBe('Europe/Stockholm');
    // The brief, the day view and the card read all use it: 09:05Z is 11:05 on the 7th in Stockholm.
    expect((await me('GET', '/api/me/brief')).body).toMatchObject({ date: '2026-10-07', timezone: 'Europe/Stockholm' });
    expect((await me('GET', '/api/me/cards?date=2026-10-07')).body.timezone).toBe('Europe/Stockholm');
    // A signed-out device no longer counts.
    await me('DELETE', `/api/me/devices/${owner.deviceId}`);
    owner = phone;
    expect((await settings()).timezone).toBe('America/Denver');
  });

  it('an override set in settings wins over the devices until it is cleared', async () => {
    await zone(owner.auth, 'America/Denver');
    const set = await me('PATCH', '/api/me/settings', { timezone: 'Europe/Copenhagen' });
    expect(set.body).toMatchObject({ timezone: 'Europe/Copenhagen', timezone_source: 'override', timezone_override: 'Europe/Copenhagen', device_timezone: { timezone: 'America/Denver' } });
    await zone(owner.auth, 'Asia/Tokyo');
    expect((await settings()).timezone).toBe('Europe/Copenhagen');
    expect((await me('GET', '/api/me/brief')).body.timezone).toBe('Europe/Copenhagen');
    const cleared = await me('PATCH', '/api/me/settings', { timezone: null });
    expect(cleared.body).toMatchObject({ timezone: 'Asia/Tokyo', timezone_source: 'device', timezone_override: null });
  });

  it('refuses an unknown X-Timezone with 400, after the credential, and stores nothing', async () => {
    for (const tz of ['Mars/Olympus', '+02:00', '', 'Europe/Copenhagen; drop table']) {
      expect(await zone(owner.auth, tz), JSON.stringify(tz)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect((await call('GET', '/api/me', { headers: { 'x-timezone': 'Mars/Olympus' } })).status).toBe(401);
    expect((await call('GET', '/api/me', { auth: hermes, headers: { 'x-timezone': 'Mars/Olympus' } })).status).toBe(401);
    expect((await settings()).device_timezone).toBeNull();
    for (const timezone of ['Mars/Olympus', '+02:00', 3]) expect((await me('PATCH', '/api/me/settings', { timezone })).status).toBe(400);
  });

  it('sets and clears the display name; the head id producers address does not change', async () => {
    expect((await me('PATCH', '/api/me/settings', { display_name: '  Morten Nielsen ' })).body).toMatchObject({ head: OWNER, display_name: 'Morten Nielsen' });
    expect((await me('GET', '/api/me')).body).toMatchObject({ head: OWNER, display_name: 'Morten Nielsen' });
    for (const display_name of ['', '   ', 'two\nlines', 'x'.repeat(101), 7]) expect((await me('PATCH', '/api/me/settings', { display_name })).status, JSON.stringify(display_name)).toBe(400);
    expect((await me('PATCH', '/api/me/settings', { display_name: null })).body.display_name).toBeNull();
    expect((await call('GET', '/')).body.owner).toBe(OWNER);
  });
});

describe('producers and devices', () => {
  it('lists producers; a ceiling change applies to the next card, revoking silences the producer', async () => {
    await put('hermes:gmail:1');
    const list = (await me('GET', '/api/me/producers')).body.producers;
    expect(list).toEqual([expect.objectContaining({ root: 'hermes', ceiling: 'immediate', revoked: false, last_card_at: '2026-10-07T09:00:00Z' })]);
    expect((await me('PATCH', '/api/me/producers/hermes', { ceiling: 'log' })).body.ceiling).toBe('log');
    await put('hermes:gmail:2', { urgency: 'immediate' });
    const [row] = await testDb().select().from(cards).where(and(eq(cards.headId, OWNER), eq(cards.id, 'hermes:gmail:2')));
    expect(row).toMatchObject({ urgency: 'immediate', delivery: 'log' });
    expect((await me('PATCH', '/api/me/producers/hermes', { revoked: true })).body.revoked).toBe(true);
    expect((await put('hermes:gmail:3')).status).toBe(401);
    expect((await me('PATCH', '/api/me/producers/nobody', { ceiling: 'log' })).status).toBe(404);
    expect((await me('PATCH', '/api/me/producers/hermes', { ceiling: 'loud' })).status).toBe(400);
  });

  it('lists devices, marks the current one, and signs another one out', async () => {
    const phone = await ownerSession(OWNER, 'phone');
    const list = (await me('GET', '/api/me/devices')).body.devices;
    expect(list.map((d: { name: string; current: boolean }) => [d.name, d.current]).sort()).toEqual([['phone', false], ['test device', true]]);
    expect((await me('DELETE', `/api/me/devices/${phone.deviceId}`)).status).toBe(204);
    expect((await call('GET', '/api/me/brief', { auth: phone.auth })).status).toBe(401);
    expect((await me('DELETE', `/api/me/devices/${phone.deviceId}`)).status).toBe(404);
  });

  it('every /api/me route requires a session; a producer token is refused', async () => {
    for (const path of ['/api/me', '/api/me/brief', '/api/me/cards', '/api/me/producers', '/api/me/devices']) {
      expect((await call('GET', path, { auth: hermes })).status, path).toBe(401);
    }
  });
});
