import { HeadClient } from '@pbcp/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { ensureHead } from '../../lib/heads';
import { call, headUrl, OWNER, resetHead, testDb } from './helpers';

beforeEach(() => resetHead());

describe('GET / (§7.5)', () => {
  it('describes the only head without credentials', async () => {
    const r = await call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ protocol: 'pbcp/1', owner: OWNER, api: `${headUrl()}/api`, seq: 0, extensions: ['orders'], render: { mermaid: ['core', 'extended'] } });
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

describe('GET /: JSON for producers, the front door for a browser (Accept)', () => {
  const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  const DESCRIPTION = () => ({ protocol: 'pbcp/1', owner: OWNER, api: `${headUrl()}/api`, seq: 0, extensions: ['orders'], render: { mermaid: ['core', 'extended'] } });

  it('serves the describe JSON, unchanged, when the request does not prefer text/html', async () => {
    for (const accept of [undefined, '*/*', 'application/json', 'application/json, text/html', 'text/html;q=0.5, application/json', 'text/html, application/json']) {
      const r = await call('GET', '/', accept ? { headers: { accept } } : {});
      expect(r.status, String(accept)).toBe(200);
      expect(r.headers.get('content-type'), String(accept)).toMatch(/^application\/json/);
      expect(r.body, String(accept)).toEqual(DESCRIPTION());
      expect(r.headers.get('vary')).toMatch(/accept/i);
    }
  });

  it('serves the front door when text/html is preferred over application/json', async () => {
    for (const accept of [BROWSER, 'text/html', 'text/html, application/json;q=0.9']) {
      const r = await call('GET', '/', { headers: { accept } });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/^text\/html/);
      expect(r.headers.get('vary')).toMatch(/accept/i);
      expect(r.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-/);
      const html = r.body as string;
      expect(html).toContain('Your day, unified.');
      expect(html).toContain('href="https://morkeleb.github.io/pbcp"');
      expect(html).toContain('>Personal Brief Card Protocol</a>');
      expect(html).toContain('href="/connect"');
      expect(html).toContain('href="/signin"');
    }
  });

  it('gives HeadClient.describe the JSON', async () => {
    const token = await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' });
    expect(await new HeadClient({ baseUrl: headUrl(), token }).describe()).toMatchObject({ owner: OWNER, protocol: 'pbcp/1' });
  });

  it('serves /api/openapi.json publicly', async () => {
    const r = await call('GET', '/api/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3\./);
    expect(r.body.paths['/api/me/brief']).toBeDefined();
  });
});
