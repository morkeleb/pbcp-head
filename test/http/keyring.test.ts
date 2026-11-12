// One unwrap per request (lib/keyring.ts): every open in a brief shares the request's keyring, so the head's data key is
// unwrapped once however many queries open rows: decisions, tasks, signals, tomorrow, the paragraph so far today and the
// nightly card's, and a diagram.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { mintDailyCard } from '../../lib/brief/nightly';
import * as keys from '../../lib/keys';
import { brief } from '../../lib/me';
import { card, cardPath } from './cards';
import { call, OWNER, resetHead, testDb } from './helpers';

vi.mock('../../lib/keys', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/keys')>();
  return { ...real, dataKey: vi.fn(real.dataKey) };
});

beforeEach(async () => {
  await resetHead();
  await call('POST', '/api/test', { body: { clock: '2026-10-07T09:00:00Z' } });
  const mail = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'mail', ceiling: 'immediate' })}`;
  const put = (id: string, fields: Record<string, unknown>) => call('PUT', cardPath(id), { auth: mail, body: card(id, fields) });
  await put('mail:inbox:1', { title: 'Reply to Anna', summary: 'About the invoice.' });
  await put('mail:inbox:2', { title: 'Archive the receipt', actions: [{ id: 'archive', label: 'Archive', default: true }, 'keep'] });
  await put('mail:todo:1', { kind: 'task', title: 'Pay the invoice' });
  await put('mail:news:1', { kind: 'artifact', title: 'Weekly chart', body: '```mermaid\npie title Week\n  "A" : 1\n  "B" : 2\n```' });
  await put('mail:news:2', { kind: 'signal', title: 'Tomorrow', about: '2026-10-08' });
});
afterEach(() => call('POST', '/api/test', { body: { clock: null } }));

describe('the keyring', () => {
  it('unwraps the data key once for a whole brief, so far today and with the nightly card', async () => {
    const dataKey = vi.mocked(keys.dataKey);

    dataKey.mockClear();
    const sofar = await brief(testDb(), OWNER);
    expect(sofar.daily_paragraph?.so_far).toBe(true);
    expect(sofar.decisions.length).toBeGreaterThan(0);
    expect(dataKey).toHaveBeenCalledTimes(1);

    await mintDailyCard(testDb(), OWNER, 'UTC', '2026-10-07');
    dataKey.mockClear();
    const minted = await brief(testDb(), OWNER);
    expect(minted.daily?.id).toBe('head:daily:2026-10-07');
    expect(dataKey).toHaveBeenCalledTimes(1);

    // A second request unwraps again: nothing is kept beyond the request.
    dataKey.mockClear();
    await brief(testDb(), OWNER);
    expect(dataKey).toHaveBeenCalledTimes(1);
  });
});
