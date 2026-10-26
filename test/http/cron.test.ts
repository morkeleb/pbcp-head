import { beforeEach, describe, expect, it } from 'vitest';
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
    await call('PATCH', '/api/me', { auth: owner.auth, body: { timezone: 'Europe/Copenhagen' } });
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
    expect(brief.daily.body).toContain('**1 open decision** · 2 cards yesterday from 1 producer');
    expect(brief.daily.rendered_html).toMatch(/\/api\/me\/svg\/[0-9a-f]{64}/);
    expect(brief.daily.first_visual).toMatchObject({ kind: 'diagram', caption: 'Cards yesterday by producer' });
    expect(brief.threads).toEqual([]); // the head's own card is the brief, not one of its folds
  });

  it('refuses anything but the cron secret', async () => {
    for (const auth of ['', 'Bearer wrong', hermes, `Session ${TEST_CRON_SECRET}`]) expect((await cron(auth)).status).toBe(401);
  });
});
