// /connect and /llms.txt: how a producer connects, public, from the same code (lib/connect.ts). They show the api base
// and owner id, and never a token: <token> is the only one there is.

import { curlSnippet } from '@pbcp/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureHead } from '../../lib/heads';
import { call, headUrl, OWNER, ownerSession, resetHead, testDb } from './helpers';

beforeEach(() => resetHead());

const BROWSER = 'text/html,application/xhtml+xml,*/*;q=0.8';
/** No producer token in the text, and every "Bearer " is followed by the placeholder (HTML-escaped on the page). */
function noToken(text: string) {
  expect(text).not.toMatch(/pbcp_[A-Za-z0-9_-]{20,}/);
  const bearers = [...text.matchAll(/Bearer (\S+)/g)].map((m) => m[1]!);
  expect(bearers.length).toBeGreaterThan(0);
  // As written, HTML-escaped in the page, or escaped in its embedded RSC data.
  for (const b of bearers) expect(['<token>', '&lt;token&gt;', '\\u003ctoken\\u003e'].some((p) => b.startsWith(p)), b).toBe(true);
}

describe('GET /connect', () => {
  it('is public HTML with the api base, owner id, protocol and extensions, the curl with <token>, and the links', async () => {
    await ownerSession(); // a signed-in owner exists; the page does not need one
    const r = await call('GET', '/connect', { headers: { accept: BROWSER } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    const html = r.body as string;
    expect(html).toContain(`${headUrl()}/api`);
    expect(html).toContain(`data-value="owner">${OWNER}<`);
    expect(html).toContain('pbcp/1');
    expect(html).toMatch(/<code[^>]*>orders<\/code>/);
    expect(html).toContain('Tokens are minted by this head’s owner on the');
    expect(html).toContain('href="/settings"');
    for (const href of [`${headUrl()}/api/openapi.json`, '/rfc.md', 'connectors/hermes/README.md#setup', 'connectors/goalpath/README.md#setup']) expect(html).toContain(href);
    expect(html).toContain('PBCP_TOKEN');
    noToken(html);
  });

  it('on a deployment with several heads, leaves <owner> as a placeholder and says where it comes from', async () => {
    await ensureHead(testDb(), 'anna');
    const html = (await call('GET', '/connect')).body as string;
    expect(html).toContain('data-multi-head');
    expect(html).toContain('which the owner gives you from their settings page');
    expect(html).toContain('&lt;owner&gt;');
    expect(html).not.toContain(`data-value="owner">${OWNER}<`);
  });
});

describe('GET /llms.txt', () => {
  it('is public plain text: what the head is, the facts, the three values, the curl with <token>, the links', async () => {
    const r = await call('GET', '/llms.txt');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = r.body as string;
    const api = `${headUrl()}/api`;
    expect(text).toMatch(/^# This head\n\nThis is a head for the Personal Brief Card Protocol/);
    expect(text).toContain(`- API base: ${api}`);
    expect(text).toContain(`- Owner id (to_person): ${OWNER}`);
    expect(text).toContain(`- PBCP_HEAD_URL=${api}`);
    expect(text).toContain('- PBCP_TOKEN=<token>');
    expect(text).toContain(curlSnippet({ api, owner: OWNER, token: '<token>' }));
    expect(text).toContain("Tokens are minted by this head's owner on the settings page");
    expect(text).toContain(`(${headUrl()}/api/openapi.json)`);
    expect(text).toContain('/rfc.md)');
    expect(text).toContain('connectors/todoist/README.md#setup');
    noToken(text);
  });

  it('says <owner> comes from the settings page on a deployment with several heads', async () => {
    await ensureHead(testDb(), 'anna');
    const text = (await call('GET', '/llms.txt')).body as string;
    expect(text).toContain("- Owner id (to_person): <owner> (this deployment serves several heads; the owner id comes from the owner's settings page)");
    expect(text).toContain('PBCP_TO_PERSON=<owner>');
  });
});
