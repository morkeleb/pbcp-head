// The pure parts of the hardening pass: the image proxy's size and type limits, the page CSP and the
// test-mode guard. The HTTP behaviour is in test/http/hardening.test.ts.

import { describe, expect, it } from 'vitest';
import { refuseTestModeInProduction } from '../lib/boot';
import { MAX_IMAGE_BYTES, readImage } from '../lib/render/fetch-image';
import { pageCsp } from '../lib/security';

function response(type: string, bytes: number, opts: { declare?: boolean; status?: number } = {}) {
  const headers = new Headers({ 'content-type': type });
  if (opts.declare) headers.set('content-length', String(bytes));
  async function* body() {
    for (let left = bytes; left > 0; left -= 64 * 1024) yield new Uint8Array(Math.min(left, 64 * 1024));
  }
  return { ok: (opts.status ?? 200) < 300, headers, body: body() };
}

describe('the image proxy', () => {
  it('is limited to 2 MB', () => expect(MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024));

  it('passes an image up to the limit', async () => {
    expect((await readImage(response('image/png', MAX_IMAGE_BYTES, { declare: true })))?.body.length).toBe(MAX_IMAGE_BYTES);
  });

  it('refuses a larger image, declared or not', async () => {
    expect(await readImage(response('image/png', MAX_IMAGE_BYTES + 1, { declare: true }))).toBeNull();
    expect(await readImage(response('image/jpeg', MAX_IMAGE_BYTES + 1))).toBeNull();
  });

  it('refuses anything that is not an image type', async () => {
    for (const type of ['text/html', 'application/octet-stream', 'image/x-icon', 'application/javascript', '']) {
      expect(await readImage(response(type, 10))).toBeNull();
    }
    expect(await readImage(response('image/png', 10, { status: 404 }))).toBeNull();
  });
});

describe('the page CSP', () => {
  it('allows scripts only by nonce, and eval only in development', () => {
    expect(pageCsp('abc', false)).toContain("script-src 'self' 'nonce-abc';");
    expect(pageCsp('abc', true)).toContain("'unsafe-eval'");
    expect(/script-src ([^;]*)/.exec(pageCsp('abc', false))![1]).not.toContain('unsafe-inline');
  });
});

describe('test mode', () => {
  it('refuses to boot when set on a production deployment', () => {
    expect(() => refuseTestModeInProduction({ PBCP_TEST_MODE: '1', VERCEL_ENV: 'production' })).toThrow(/refusing to start/);
    expect(() => refuseTestModeInProduction({ PBCP_TEST_MODE: '1', VERCEL_ENV: 'preview' })).not.toThrow();
    expect(() => refuseTestModeInProduction({ VERCEL_ENV: 'production' })).not.toThrow();
  });
});
