// Which Chromium draws diagrams, from PBCP_CHROMIUM_PATH:
//
//   unset                the build puppeteer downloaded on install (local development); on Vercel
//                        (VERCEL set), @sparticuz/chromium
//   @sparticuz/chromium  the serverless build in that package, inflated into /tmp on first use
//   /path/to/chromium    that binary (the Docker image's /usr/bin/chromium, or any other)
//
// Whichever it is, the network flags in ./draw are added to its own.

export const SERVERLESS = '@sparticuz/chromium';

/**
 * Flags of the serverless build that this head does not want. Drawing needs no cross-origin access and no
 * mixed content, so the browser keeps its web security; headless mode is puppeteer's `headless` option.
 */
const UNWANTED = new Set(['--disable-web-security', '--allow-running-insecure-content']);

export interface ChromiumLaunch {
  executablePath?: string;
  args: string[];
  headless: true | 'shell';
}

export async function chromium(): Promise<ChromiumLaunch> {
  const path = process.env.PBCP_CHROMIUM_PATH || (process.env.VERCEL ? SERVERLESS : undefined);
  if (!path) return { args: [], headless: true };
  if (path !== SERVERLESS) return { executablePath: path, args: [], headless: true };
  const { default: serverless } = await import('@sparticuz/chromium');
  // No WebGL: mermaid draws SVG, and skipping SwiftShader saves inflating it on every cold start.
  serverless.setGraphicsMode = false;
  return {
    executablePath: await serverless.executablePath(),
    args: serverless.args.filter((a) => !UNWANTED.has(a) && !a.startsWith('--headless')),
    // The serverless build is chrome-headless-shell only.
    headless: 'shell',
  };
}
