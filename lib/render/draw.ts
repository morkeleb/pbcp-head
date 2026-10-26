// Drawing a sanitised fence to SVG with the mermaid CLI's renderer in headless Chromium.
//
// No network (§3.1 "Declarative only"): Chromium is launched with a proxy that does not exist, so any
// request that would leave the machine fails. mermaid-cli serves its own scripts and fonts from local
// files through request interception, which never reaches the proxy. Mermaid itself runs with
// securityLevel strict and htmlLabels off, so labels are SVG text, not foreignObject HTML.

import { renderMermaid } from '@mermaid-js/mermaid-cli';
import { createRequire } from 'node:module';
import puppeteer, { type Browser, type Page } from 'puppeteer';

/** A fence mermaid could not draw: deterministic, so it is cached and shown as the §3.1 fallback with this message. */
export class DiagramError extends Error {
  override readonly name = 'DiagramError';
}

const g = globalThis as unknown as {
  __pbcpBrowser?: Promise<Browser>;
  __pbcpParser?: Promise<Page>;
  __pbcpDrawing?: number;
  __pbcpQueue?: Array<() => void>;
};
const MAX_PARALLEL = 4;
const TIMEOUT_MS = 15_000;

function browser(): Promise<Browser> {
  g.__pbcpBrowser ??= puppeteer
    .launch({
      headless: true,
      ...(process.env.PBCP_CHROMIUM_PATH ? { executablePath: process.env.PBCP_CHROMIUM_PATH } : {}),
      args: [
        '--proxy-server=http://127.0.0.1:9',
        '--proxy-bypass-list=<-loopback>',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-first-run',
        '--disable-sync',
        '--disable-dev-shm-usage',
        ...(process.env.PBCP_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      ],
    })
    .then((b) => {
      b.on('disconnected', () => {
        g.__pbcpBrowser = undefined;
        g.__pbcpParser = undefined;
      });
      return b;
    })
    .catch((e) => {
      g.__pbcpBrowser = undefined;
      throw e;
    });
  return g.__pbcpBrowser;
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  g.__pbcpDrawing ??= 0;
  g.__pbcpQueue ??= [];
  while (g.__pbcpDrawing >= MAX_PARALLEL) await new Promise<void>((r) => g.__pbcpQueue!.push(r));
  g.__pbcpDrawing++;
  try {
    return await fn();
  } finally {
    g.__pbcpDrawing--;
    g.__pbcpQueue.shift()?.();
  }
}

const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  theme: 'default',
} as const;

/** Mermaid's own refusals (parse errors, unknown syntax) as opposed to the browser failing. */
function mermaidMessage(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (/TimeoutError|Target closed|Protocol error|Session closed|browser has disconnected|Navigating frame was detached/i.test(msg)) return null;
  return msg.replace(/^Error:\s*/, '').replace(/^Evaluation failed:\s*(Error:\s*)?/, '').split('\n    at ')[0]!.trim();
}

/**
 * A page holding mermaid's standalone bundle, loaded from the local file, for `mermaid.parse`. Mermaid 12
 * answers a parse error in `render` by drawing an error graphic without the message; §3.1 wants the
 * parser's message in the fallback, so a failed draw is parsed here to get it.
 */
function parser(): Promise<Page> {
  g.__pbcpParser ??= (async () => {
    const page = await (await browser()).newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js') });
    await page.evaluate((config) => (window as unknown as { mermaid: { initialize(c: unknown): void } }).mermaid.initialize(config), MERMAID_CONFIG);
    return page;
  })().catch((e) => {
    g.__pbcpParser = undefined;
    throw e;
  });
  return g.__pbcpParser;
}

async function parseError(source: string): Promise<string> {
  const page = await parser();
  const message = await page.evaluate(async (src) => {
    try {
      await (window as unknown as { mermaid: { parse(s: string): Promise<unknown> } }).mermaid.parse(src);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, source);
  return message ?? 'mermaid could not draw this diagram';
}

/**
 * Draws `source` (already sanitised) to SVG text. A DiagramError means mermaid refused the source; any
 * other error is the drawing infrastructure, which callers must not cache.
 */
export async function drawSvg(source: string, svgId: string): Promise<string> {
  return slot(async () => {
    const b = await browser();
    let timer: NodeJS.Timeout | undefined;
    try {
      const drawn = await Promise.race([
        renderMermaid(b, source, 'svg', { mermaidConfig: MERMAID_CONFIG as never, backgroundColor: 'transparent', fontEmbed: false, svgId }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('TimeoutError: drawing took too long')), TIMEOUT_MS);
        }),
      ]);
      const svg = new TextDecoder().decode(drawn.data);
      if (/^<svg[^>]*aria-roledescription="error"/.test(svg)) throw new DiagramError(await parseError(source));
      return svg;
    } catch (e) {
      if (e instanceof DiagramError) throw e;
      const message = mermaidMessage(e);
      if (message !== null) throw new DiagramError(message || 'the diagram could not be parsed');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function closeBrowser(): Promise<void> {
  const b = g.__pbcpBrowser;
  g.__pbcpBrowser = undefined;
  if (b) await (await b).close();
}
