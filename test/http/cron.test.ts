import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cards } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { TEST_CRON_SECRET } from '../env';
import { card, cardPath } from './cards';
import { call, OWNER, ownerSession, resetHead, testDb } from './helpers';

let hermes: string;
const clock = (at: string) => call('POST', '/api/test', { body: { clock: at } });
const cron = (auth = `Bearer ${TEST_CRON_SECRET}`) => call('GET', '/api/cron/brief', { auth });

beforeEach(async () => {
  await resetHead();
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
});

describe('GET /api/cron/brief', () => {
  it("mints head:daily for the local date once the head's clock passes 05:30, once", async () => {
    const owner = await ownerSession();
    await call('PATCH', '/api/me/settings', { auth: owner.auth, body: { timezone: 'Europe/Copenhagen' } });
    await clock('2026-10-06T10:00:00Z');
    await call('PUT', cardPath('hermes:gmail:1'), { auth: hermes, body: card('hermes:gmail:1') });
    await call('PUT', cardPath('hermes:gmail:2'), { auth: hermes, body: card('hermes:gmail:2', { kind: 'signal', thread: 't' }) });

    await clock('2026-10-07T03:00:00Z'); // 05:00 in Copenhagen
    expect((await cron()).body).toEqual({ minted: [] });
    await clock('2026-10-07T03:30:00Z'); // 05:30
    expect((await cron()).body).toEqual({ minted: [{ head: OWNER, id: 'head:daily:2026-10-07', status: 201 }] });
    expect((await cron()).body).toEqual({ minted: [] });

    const brief = (await call('GET', '/api/me/brief', { auth: owner.auth })).body;
    expect(brief.daily).toMatchObject({ id: 'head:daily:2026-10-07', kind: 'artifact', producer: 'head', references: ['hermes:gmail:1'] });
    expect(brief.daily.body).toContain('1 open decision · 2 cards yesterday from 1 producer');
    // Each line links to the card's page in the head; the renderer keeps that link in the app.
    expect(brief.daily.rendered_html).toContain(`href="/card/${encodeURIComponent('hermes:gmail:1')}"`);
    expect(brief.daily.rendered_html).not.toContain('/api/me/svg/'); // no chart: §8, counts are additions
    expect(brief.daily.lead).toBe('1 open decision · 2 cards yesterday from 1 producer'); // its summary
    expect(brief.threads).toEqual([]); // the head's own card is the brief, not one of its folds
  });

  it('follows the owner from Denver to Stockholm mid-day and mints the day exactly once', async () => {
    const phone = await ownerSession(OWNER, 'phone');
    const at = (zone: string) => call('GET', '/api/me', { auth: phone.auth, headers: { 'x-timezone': zone } });
    // 2026-10-07 06:00 in Denver (MDT, UTC-6): the phone is there; the day's card is minted at Denver's 05:30.
    await clock('2026-10-07T12:00:00Z');
    await at('America/Denver');
    expect((await cron()).body).toEqual({ minted: [{ head: OWNER, id: 'head:daily:2026-10-07', status: 201 }] });
    // The flight lands: 2026-10-08 08:00 in Stockholm is still 2026-10-08 00:00 in Denver. Same instant, two
    // calendars; the phone now says Stockholm, so it is the 8th, 05:30 has passed, and the 8th has no card.
    await clock('2026-10-08T06:00:00Z');
    await at('Europe/Stockholm');
    expect((await cron()).body).toEqual({ minted: [{ head: OWNER, id: 'head:daily:2026-10-08', status: 201 }] });
    // Hourly runs for the rest of the day, in either zone, mint nothing more.
    for (const t of ['2026-10-08T07:30:00Z', '2026-10-08T12:30:00Z', '2026-10-08T21:30:00Z']) {
      await clock(t);
      expect((await cron()).body).toEqual({ minted: [] });
    }
    await at('America/Denver'); // back again: in Denver it is still the 8th, which has its card
    await clock('2026-10-08T22:30:00Z');
    expect((await cron()).body).toEqual({ minted: [] });
    const days = await testDb().select({ id: cards.id }).from(cards).where(and(eq(cards.headId, OWNER), eq(cards.namespace, 'daily')));
    expect(days.map((d) => d.id).sort()).toEqual(['head:daily:2026-10-07', 'head:daily:2026-10-08']);
  });

  it('a mid-day move from Denver to Stockholm on the same date neither doubles nor skips the day', async () => {
    const phone = await ownerSession(OWNER, 'phone');
    const at = (zone: string) => call('GET', '/api/me', { auth: phone.auth, headers: { 'x-timezone': zone } });
    await clock('2026-10-07T04:30:00Z'); // 22:30 on the 6th in Denver: before 05:30 on the 7th
    await at('America/Denver');
    expect((await cron()).body).toEqual({ minted: [{ head: OWNER, id: 'head:daily:2026-10-06', status: 201 }] });
    await clock('2026-10-07T11:30:00Z'); // 05:30 on the 7th in Denver
    expect((await cron()).body).toEqual({ minted: [{ head: OWNER, id: 'head:daily:2026-10-07', status: 201 }] });
    await clock('2026-10-07T13:00:00Z'); // mid-day; the owner is now in Stockholm, 15:00 on the 7th
    await at('Europe/Stockholm');
    for (const t of ['2026-10-07T13:30:00Z', '2026-10-07T18:30:00Z', '2026-10-07T21:30:00Z']) {
      await clock(t);
      expect((await cron()).body).toEqual({ minted: [] });
    }
    await clock('2026-10-08T03:30:00Z'); // 05:30 on the 8th in Stockholm
    expect((await cron()).body).toEqual({ minted: [{ head: OWNER, id: 'head:daily:2026-10-08', status: 201 }] });
    const days = await testDb().select({ id: cards.id }).from(cards).where(and(eq(cards.headId, OWNER), eq(cards.namespace, 'daily')));
    expect(days.map((d) => d.id).sort()).toEqual(['head:daily:2026-10-06', 'head:daily:2026-10-07', 'head:daily:2026-10-08']);
  });

  it('refuses anything but the cron secret', async () => {
    for (const auth of ['', 'Bearer wrong', hermes, `Session ${TEST_CRON_SECRET}`]) expect((await cron(auth)).status).toBe(401);
  });
});
