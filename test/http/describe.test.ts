import { beforeEach, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { ensureHead } from '../../lib/heads';
import { call, OWNER, resetHead, testDb } from './helpers';

beforeEach(() => resetHead());

describe('GET / (§7.5)', () => {
  it('describes the only head without credentials', async () => {
    const r = await call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ protocol: 'pbcp/1', owner: OWNER, seq: 0, extensions: [], render: { mermaid: ['core', 'extended'] } });
  });

  it('is also served at /api, for a HeadClient whose baseUrl ends in /api', async () => {
    const r = await call('GET', '/api/');
    expect(r.status).toBe(200);
    expect(r.body.owner).toBe(OWNER);
  });

  it("describes the token's head when several heads share a deployment", async () => {
    await ensureHead(testDb(), 'anna');
    expect((await call('GET', '/')).status).toBe(404);
    const token = await mintProducerToken(testDb(), { headId: 'anna', root: 'hermes' });
    const r = await call('GET', '/', { auth: `Bearer ${token}` });
    expect(r.status).toBe(200);
    expect(r.body.owner).toBe('anna');
  });

  it('refuses a token it does not accept with 401 unauthorized', async () => {
    const r = await call('GET', '/', { auth: 'Bearer pbcp_nope' });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'unauthorized' });
  });
});
