// What a head needs before it is exposed (docs/deploy.md "Hardening"): rate limits, the 1 MiB body limit
// enforced before the body is read, security headers, and the test-mode guard. The image proxy's limits
// and the pure parts are in test/hardening-unit.test.ts; the CSP in a real browser is in ui.test.ts.

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintProducerToken } from '../../lib/auth/producer';
import { TEST_DATABASE_URL, TEST_SESSION_SECRET } from '../env';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

const limits = (rateLimits: Record<string, number> | null) => call('POST', '/api/test', { body: { rateLimits } });
const token = async (root = 'goalpath') => `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root })}`;
const MiB = 1024 * 1024;

beforeEach(() => resetHead());
afterEach(() => limits(null));

describe('rate limits', () => {
  it('limit PUT per producer token with 429 rate_limited and Retry-After, after 401', async () => {
    await limits({ put: 2 });
    const a = await token('goalpath');
    const b = await token('mail');
    for (const n of [1, 2]) expect((await call('PUT', cardPath(`goalpath:x:${n}`), { auth: a, body: card(`goalpath:x:${n}`) })).status).toBe(201);
    const third = await call('PUT', cardPath('goalpath:x:3'), { auth: a, body: card('goalpath:x:3') });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: 'rate_limited' });
    const retry = Number(third.headers.get('retry-after'));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    // Another token has its own count; a bad token is 401 before any count (§7.1 order).
    expect((await call('PUT', cardPath('mail:x:1'), { auth: b, body: card('mail:x:1') })).status).toBe(201);
    expect((await call('PUT', cardPath('goalpath:x:4'), { auth: 'Bearer nope', body: card('goalpath:x:4') })).status).toBe(401);
  });

  it('limit sync per producer token', async () => {
    await limits({ changes: 1 });
    const a = await token();
    expect((await call('GET', '/api/changes?after=0', { auth: a })).status).toBe(200);
    const r = await call('GET', '/api/changes?after=0', { auth: a });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await call('GET', '/api/changes?after=0', { auth: await token('mail') })).status).toBe(200);
  });

  it('limit /api/auth/* per client address', async () => {
    await limits({ auth: 2 });
    const from = (ip: string) => fetch(`${headUrl()}/api/auth/passkey/login/options`, { method: 'POST', headers: { 'x-real-ip': ip } });
    expect((await from('203.0.113.7')).status).toBe(200);
    expect((await from('203.0.113.7')).status).toBe(200);
    const third = await from('203.0.113.7');
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await from('203.0.113.8')).status).toBe(200);
  });
});

/** A raw request that declares `length` bytes but sends only `sent` of them, and never ends. */
function declare(method: string, path: string, length: number, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(`${headUrl()}${path}`, { method, headers: { 'content-type': 'application/json', 'content-length': String(length), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => reject(new Error('the head waited for the body')));
    req.write('{"protocol":'); // a fraction of what was declared; the head must answer without the rest
  });
}

describe('413 before the body is read', () => {
  it('answers a declared oversized card PUT without waiting for its body, in §7.1 order', async () => {
    const id = 'goalpath:big:1';
    const a = await token();
    expect(await declare('PUT', cardPath(id), 2 * MiB)).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    expect(await declare('PUT', cardPath(id), 2 * MiB, { authorization: 'Bearer nope' })).toMatchObject({ status: 401 });
    expect(await declare('PUT', cardPath(id), 2 * MiB, { authorization: a })).toMatchObject({ status: 413, body: { error: 'too_large' } });
    expect(await declare('PUT', cardPath(id), MiB + 1, { authorization: a })).toMatchObject({ status: 413 });
    await limits({ put: 0 });
    expect(await declare('PUT', cardPath(id), 2 * MiB, { authorization: a })).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  });

  it('refuses any other oversized API body the same way', async () => {
    const { auth } = await ownerSession();
    expect(await declare('POST', '/api/me/orders', 5 * MiB, { authorization: auth })).toMatchObject({ status: 413, body: { error: 'too_large' } });
    expect(await declare('POST', '/api/auth/refresh', 2 * MiB)).toMatchObject({ status: 413 });
  });

  it('cuts off a body sent without a Content-Length once it passes 1 MiB', async () => {
    const a = await token();
    const big = JSON.stringify(card('goalpath:big:2', { body: 'x'.repeat(MiB + 10) }));
    const chunks = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(big);
        for (let i = 0; i < bytes.length; i += 64 * 1024) c.enqueue(bytes.slice(i, i + 64 * 1024));
        c.close();
      },
    });
    const res = await fetch(`${headUrl()}${cardPath('goalpath:big:2')}`, { method: 'PUT', headers: { authorization: a, 'content-type': 'application/json' }, body: chunks, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'too_large' });
  });

  it('still accepts a 64 KiB card', async () => {
    const r = await call('PUT', cardPath('goalpath:ok:1'), { auth: await token(), body: card('goalpath:ok:1', { body: 'y'.repeat(60 * 1024) }) });
    expect(r.status).toBe(201);
  });
});

describe('security headers', () => {
  it('give every page a fresh nonce CSP: no inline scripts, images only from the head', async () => {
    const one = await fetch(`${headUrl()}/brief`);
    const two = await fetch(`${headUrl()}/brief`);
    const csp = one.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(two.headers.get('content-security-policy')).not.toContain(nonce);
    const script = /script-src ([^;]*)/.exec(csp)![1]!;
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Every script on the page carries this request's nonce.
    const html = await one.text();
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
    expect(one.headers.get('x-content-type-options')).toBe('nosniff');
    expect(one.headers.get('x-frame-options')).toBe('DENY');
    expect(one.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('serve API responses, rendered_html included, under a CSP with no scripts at all', async () => {
    const a = await token();
    await call('PUT', cardPath('goalpath:item:1'), { auth: a, body: card('goalpath:item:1') });
    const { auth } = await ownerSession();
    for (const path of ['/api/me/brief', `/api/me/cards/${encodeURIComponent('goalpath:item:1')}`, '/api/changes?after=0']) {
      const r = await call('GET', path, { auth: path.startsWith('/api/me') ? auth : a });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('keep the image routes’ own image CSP', async () => {
    const r = await fetch(`${headUrl()}/api/me/svg/${'0'.repeat(64)}`);
    expect(r.status).toBe(404);
    const img = await fetch(`${headUrl()}/api/me/img?u=https%3A%2F%2Fexample.com%2Fa.png&s=bad`);
    expect(img.status).toBe(403);
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('test mode', () => {
  it('refuses to start a production deployment with PBCP_TEST_MODE set', async () => {
    const child = spawn('pnpm', ['exec', 'next', 'start', '-p', '3199'], {
      env: { ...process.env, PBCP_TEST_MODE: '1', VERCEL_ENV: 'production', DATABASE_URL: TEST_DATABASE_URL, SESSION_SECRET: TEST_SESSION_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 20_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).not.toBe(0);
    expect(code).not.toBeNull(); // it exited by itself
    expect(output).toContain('PBCP_TEST_MODE is set on a production deployment');
  });
});
