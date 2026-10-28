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
  it('is public HTML, the head’s reference: a table of contents and the four sections in order, with the facts, the curl with <token>, the assistant and the links', async () => {
    await ownerSession(); // a signed-in owner exists; the page does not need one
    const r = await call('GET', '/connect', { headers: { accept: BROWSER } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    const html = r.body as string;
    const sections = [...html.matchAll(/data-connect-section="([a-z]+)"/g)].map((m) => m[1]);
    expect(sections).toEqual(['head', 'producer', 'assistant', 'links']);
    for (const id of sections) expect(html).toContain(`href="#${id}"`);
    // This head: what GET / describes.
    expect(html).toContain(`data-value="url">${headUrl()}<`);
    expect(html).toContain(`data-value="api base">${headUrl()}/api<`);
    expect(html).toContain(`data-value="owner id">${OWNER}<`);
    expect(html).toContain('pbcp/1');
    expect(html).toMatch(/<code[^>]*>orders<\/code>/);
    expect(html).toMatch(/<code[^>]*>core, extended<\/code>/);
    // Connect a producer: the three values, a first card, pairing, each connector.
    expect(html).toContain('PBCP_TOKEN');
    expect(html).toContain('data-pairing-steps');
    expect(html).toContain('href="/settings/producers"');
    for (const name of ['hermes', 'goalpath']) expect(html).toContain(`connectors/${name}/README.md#setup`);
    // Use from an assistant: the MCP URL, Claude, ChatGPT, and signing it out.
    expect(html).toContain(`data-value="mcp">${headUrl()}/api/mcp<`);
    expect(html).toContain('data-steps="claude"');
    expect(html).toContain('Add custom connector');
    expect(html).toContain('data-steps="chatgpt"');
    expect(html).toContain('Developer mode');
    expect(html).toContain('href="/settings/devices"');
    // Links.
    for (const href of [`${headUrl()}/api/openapi.json`, 'https://morkeleb.github.io/pbcp"', 'https://morkeleb.github.io/pbcp/rfc/']) expect(html).toContain(href);
    noToken(html);
  });

  it('on a deployment with several heads, leaves <owner> as a placeholder and says where it comes from', async () => {
    await ensureHead(testDb(), 'anna');
    const html = (await call('GET', '/connect')).body as string;
    expect(html).toContain('data-multi-head');
    expect(html).toContain('which the owner gives you');
    expect(html).toContain('&lt;owner&gt;');
    expect(html).not.toContain(`data-value="owner id">${OWNER}<`);
  });
});

describe('GET /llms.txt', () => {
  it('is public plain text with the same sections as /connect: the facts, the three values, the curl with <token>, the assistant, the links', async () => {
    const r = await call('GET', '/llms.txt');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = r.body as string;
    const api = `${headUrl()}/api`;
    expect(text).toMatch(/^# This head\n\nThis is a head for the Personal Brief Card Protocol/);
    expect(text).toContain('Sections: This head · Connect a producer · Use from an assistant · Links');
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['This head', 'Connect a producer', 'Use from an assistant', 'Links']);
    expect(text).toContain(`- URL: ${headUrl()}`);
    expect(text).toContain(`- API base: ${api}`);
    expect(text).toContain(`- Owner id: ${OWNER}`);
    expect(text).toContain('- Mermaid tiers: core, extended');
    expect(text).toContain(`- PBCP_HEAD_URL=${api}`);
    expect(text).toContain('- PBCP_TOKEN=<token>');
    expect(text).toContain(curlSnippet({ api, owner: OWNER, token: '<token>' }));
    expect(text).toContain(`MCP server (streamable HTTP): ${api}/mcp`);
    expect(text).toContain('### Claude');
    expect(text).toContain('### ChatGPT');
    expect(text).toContain(`(${headUrl()}/api/openapi.json)`);
    expect(text).toContain('/rfc/)');
    expect(text).toContain('connectors/todoist/README.md#setup');
    noToken(text);
  });

  it('says <owner> is the owner’s to give on a deployment with several heads', async () => {
    await ensureHead(testDb(), 'anna');
    const text = (await call('GET', '/llms.txt')).body as string;
    expect(text).toContain('- Owner id: <owner>');
    expect(text).toContain('<owner> stands for the owner id, which the owner gives you');
    expect(text).toContain('PBCP_TO_PERSON=<owner>');
  });
});
