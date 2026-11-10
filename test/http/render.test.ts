import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cards, diagrams } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, headUrl, OWNER, resetHead, testDb, cardRow } from './helpers';

let hermes: string;
beforeEach(async () => {
  await resetHead();
  hermes = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'hermes' })}`;
});

async function renderedRow(id: string) {
  for (let i = 0; i < 100; i++) {
    const row = await cardRow(id).catch(() => undefined);
    if (row?.renderedHtml) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${id} was not rendered`);
}

describe('render on receipt', () => {
  it('renders after the PUT commits and serves the diagram from /api/me/svg/<hash>', async () => {
    const body = 'Weekly.\n\n```mermaid\npie title Split\n  "A" : 1\n  "B" : 2\n```\n\n<script>x()</script>Done.';
    const r = await call('PUT', cardPath('hermes:gmail:1'), { auth: hermes, body: card('hermes:gmail:1', { body }) });
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('rendered_html'); // never on the producer API
    const row = await renderedRow('hermes:gmail:1');
    // At rest: a head's drawing is its own, served with the head named (?h=) so its key opens it.
    const src = /\/api\/me\/svg\/[0-9a-f]{64}\?h=[^"]+/.exec(row.renderedHtml!)![0]!.replace(/&amp;/g, '&');
    expect(row.renderedHtml).not.toContain('<script');
    const svg = await fetch(`${headUrl()}${src}`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(svg.headers.get('cache-control')).toContain('immutable');
    expect(await svg.text()).toMatch(/^<svg/);
    expect((await fetch(`${headUrl()}/api/me/svg/${'0'.repeat(64)}`)).status).toBe(404);
    expect(await testDb().select().from(diagrams)).toHaveLength(1);
  });

  it('re-renders a revised body; the producer response never waits on drawing', async () => {
    await call('PUT', cardPath('hermes:gmail:2'), { auth: hermes, body: card('hermes:gmail:2', { body: 'First.' }) });
    expect((await renderedRow('hermes:gmail:2')).renderedHtml).toBe('<p>First.</p>');
    await call('PUT', cardPath('hermes:gmail:2'), { auth: hermes, body: card('hermes:gmail:2', { body: 'Second.' }) });
    for (let i = 0; i < 100 && (await renderedRow('hermes:gmail:2')).renderedHtml !== '<p>Second.</p>'; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await renderedRow('hermes:gmail:2')).renderedHtml).toBe('<p>Second.</p>');
  });

  it('a fence mermaid refuses falls back with the parser message, inside the running head too', async () => {
    const body = '```mermaid\npie title Broken\n  "A" : lots\n```';
    await call('PUT', cardPath('hermes:gmail:3'), { auth: hermes, body: card('hermes:gmail:3', { body }) });
    const row = await renderedRow('hermes:gmail:3');
    expect(row.renderedHtml).toContain('diagram could not be drawn');
    expect(row.renderedHtml).toMatch(/class="diagram-message">[^<]*(Expecting|Parse|Lexer)/);
  });

  it('GET / reports the tiers it draws', async () => {
    expect((await call('GET', '/')).body.render).toEqual({ mermaid: ['core', 'extended'] });
  });

  it('refuses an unsigned image proxy request', async () => {
    expect((await fetch(`${headUrl()}/api/me/img?u=${encodeURIComponent('https://example.com/a.png')}&s=nope`)).status).toBe(403);
  });
});
