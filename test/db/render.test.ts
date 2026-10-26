// The rendering pipeline end to end: markdown, sanitising, mermaid drawn in headless Chromium, the
// Postgres diagram cache. The conformance fixtures (R01–R08) run in test/conformance; these cover what
// they leave open.

import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { diagrams } from '../../db/schema';
import { drawCount, renderBody, resetDrawCount } from '../../lib/render';
import { closeBrowser } from '../../lib/render/draw';
import { TEST_DATABASE_URL, TEST_SESSION_SECRET } from '../env';

process.env.SESSION_SECRET = TEST_SESSION_SECRET;
const db = openDb(TEST_DATABASE_URL, 2);
afterAll(async () => {
  await closeBrowser();
  await db.$client.end();
});
beforeEach(async () => {
  await migrateDatabase(TEST_DATABASE_URL);
  await db.execute(sql`truncate diagrams`);
  resetDrawCount();
});

const fence = (src: string) => `\`\`\`mermaid\n${src}\n\`\`\``;

describe('classification', () => {
  it('draws core and extended types, falls back on Other (aliases included) with the type label', async () => {
    const r = await renderBody(db, [fence('pie title P\n "a" : 1'), fence('classDiagram\n  A <|-- B'), fence('graph LR\n  A --> B')].join('\n\n'));
    expect(r.result.fences.map((f) => [f.type, f.class])).toEqual([['pie', 'render'], ['classDiagram', 'render'], ['graph', 'fallback']]);
    expect(r.html).toContain('<strong>graph</strong> · diagram not supported');
  });

  it('a parse error falls back with mermaid’s message, in the HTML too, and the rest of the card renders', async () => {
    const r = await renderBody(db, `Before.\n\n${fence('pie title Broken\n "a" : lots')}\n\nAfter.`);
    expect(r.result.fences[0]).toMatchObject({ class: 'fallback', message: expect.stringMatching(/Expecting|Parse|Lexer/i) });
    expect(r.html).toContain('diagram could not be drawn');
    expect(r.html).toContain('class="diagram-message"');
    expect(r.result.text).toContain('After.');
  });

  it('treats a fence over 16 KiB as unsupported without drawing it', async () => {
    const big = `flowchart LR\n${Array.from({ length: 1500 }, (_, i) => `  N${i} --> N${i + 1}`).join('\n')}`;
    const r = await renderBody(db, fence(big));
    expect(r.result.fences[0]).toMatchObject({ class: 'fallback', message: expect.stringContaining('16 KiB') });
    expect(drawCount()).toBe(0);
  });

  it('collapses fences past the eighth behind a disclosure, drawn, not dropped', async () => {
    const r = await renderBody(db, Array.from({ length: 10 }, (_, i) => fence(`pie title C${i}\n "a" : ${i + 1}`)).join('\n\n'));
    expect(r.result.fences.map((f) => f.class)).toEqual([...Array(8).fill('render'), 'collapsed', 'collapsed']);
    expect((r.html.match(/<details class="diagram-collapsed">/g) ?? []).length).toBe(2);
    expect((r.html.match(/\/api\/me\/svg\//g) ?? []).length).toBe(10);
  });
});

describe('caching by sha256 of the sanitised fence', () => {
  it('draws an identical fence once, across bodies, and caches a parse error as well', async () => {
    await renderBody(db, `One.\n\n${fence('pie title Same\n "a" : 1')}`);
    await renderBody(db, `Two, different text.\n\n${fence('pie title Same\n "a" : 1')}`);
    await renderBody(db, fence('pie title Bad\n "a" : x'));
    await renderBody(db, fence('pie title Bad\n "a" : x'));
    expect(drawCount()).toBe(2);
    const rows = await db.select().from(diagrams);
    expect(rows.map((r) => [r.type, r.svg !== null, r.error !== null]).sort()).toEqual([['pie', false, true], ['pie', true, false]]);
  });

  it('a stripped directive does not make a new diagram: the cache key is the sanitised source', async () => {
    await renderBody(db, fence('flowchart LR\n  A --> B'));
    await renderBody(db, fence('flowchart LR\n  A --> B\n  click A "https://x.example"'));
    expect(drawCount()).toBe(1);
  });

  it('stores sanitised SVG with no script, foreignObject or external reference', async () => {
    await renderBody(db, fence('flowchart LR\n  A[Invoice] --> B[Reply]'));
    const [row] = await db.select().from(diagrams);
    expect(row!.svg).toMatch(/^<svg/);
    expect(row!.svg).not.toMatch(/<script|foreignObject|https?:\/\/(?!www\.w3\.org)/);
  });
});

describe('fallback images, raw HTML, links and visuals', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQqr/yHwAE0QJ9PWShagAAAABJRU5ErkJggg==';

  it('shows a fallback image in place of a failed fence, and hides it after a drawn one', async () => {
    const failed = await renderBody(db, `${fence('futurechart-beta\n a')}\n![fallback](${png})`);
    expect(failed.html).toMatch(/<figure class="diagram diagram-fallback"><img src="data:image\/png/);
    expect(failed.firstVisual).toMatchObject({ kind: 'image' });
    const drawn = await renderBody(db, `${fence('pie title X\n "a" : 1')}\n![fallback](${png})`);
    expect(drawn.html).not.toContain('data:image/png');
    expect(drawn.firstVisual).toMatchObject({ kind: 'diagram', caption: 'X' });
  });

  it('strips raw HTML keeping its text, never its scripts; inline script contents go too', async () => {
    const r = await renderBody(db, 'Hi <b>there</b> <script>steal()</script> friend.\n\n<style>p{}</style>\n\n<div>Kept</div>');
    expect(r.html).toBe('<p>Hi there  friend.</p>\n<p>Kept</p>');
    expect(r.result.stripped).toEqual(['html']);
  });

  it('proxies https images through a signed URL, links http ones, and drops other schemes to text', async () => {
    const r = await renderBody(db, '![a](https://img.example/a.png) ![b](http://img.example/b.png) ![c](javascript:alert(1)) ![d](ftp://x/y)');
    expect(r.html).toMatch(/<img src="\/api\/me\/img\?u=https%3A%2F%2Fimg\.example%2Fa\.png&#x26;s=[\w-]+" alt="a">/);
    expect(r.html).toContain('<a href="http://img.example/b.png"');
    expect(r.html).not.toMatch(/javascript:|ftp:/);
  });

  it('links open in a new tab without referrer and show the destination host (§12)', async () => {
    const r = await renderBody(db, '[Gmail thread](https://mail.google.com/x) and [mail](mailto:a@b.c)');
    expect(r.html).toContain('<a href="https://mail.google.com/x" rel="noopener noreferrer nofollow ugc" target="_blank">Gmail thread</a><span class="link-host"> (mail.google.com)</span>');
  });

  it('renders GFM tables and task lists', async () => {
    const r = await renderBody(db, '| a |\n|---|\n| 1 |\n\n- [x] done');
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<input type="checkbox" checked disabled>');
  });
});
