import type { NextConfig } from 'next';
import { refuseTestModeInProduction } from './lib/boot';
import { API_CSP, COMMON_HEADERS } from './lib/security';

refuseTestModeInProduction();

/**
 * One id per build, the same in the build and at runtime: Next.js's own build id, and baked into the service
 * worker (app/sw.js) through `env`, so each deployment ships a worker the browser sees as new.
 */
// `||`, not `??`: an env file can set these to an empty string, and an empty build id stops `next start`.
const BUILD_ID = process.env.PBCP_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || Date.now().toString(36);

/**
 * A package's files as mermaid-cli resolves them at runtime (import.meta.resolve): through pnpm's link
 * beside it, and in pnpm's store, where that link points when the function keeps it as a link.
 */
const beside = (pkg: string, files: string) => [
  `node_modules/.pnpm/@mermaid-js+mermaid-cli@*/node_modules/${pkg}/${files}`,
  ...(pkg === 'mermaid' ? [] : [`node_modules/.pnpm/${pkg.replace('/', '+')}@*/node_modules/${pkg}/${files}`]),
];

/**
 * What the draw route loads at runtime by path, which file tracing cannot see: the serverless Chromium,
 * and the scripts, stylesheets and fonts mermaid-cli serves to its page from local files.
 *
 * mermaid-cli finds those packages through pnpm's links next to it. Naming a link would bring in the whole
 * package (mermaid alone is 121 MB), so the files are named through the link instead, with each
 * package's manifest and entry module, which resolution checks for. Vercel's builder turns the mermaid
 * link into a directory holding just them and keeps the others as links, hence both paths in `beside`.
 * Verified by running the built function (docs/deploy.md, "Function sizes and cold start").
 */
const DRAW_FILES = [
  `node_modules/.pnpm/@sparticuz+chromium@*/node_modules/@sparticuz/chromium/bin/*`,
  ...beside('mermaid', 'package.json'),
  ...beside('mermaid', 'dist/mermaid.core.mjs'),
  ...beside('mermaid', 'dist/mermaid.esm.mjs'),
  ...beside('mermaid', 'dist/chunks/mermaid.esm/*.mjs'),
  ...beside('@mermaid-js/mermaid-zenuml', 'package.json'),
  ...beside('@mermaid-js/mermaid-zenuml', 'dist/mermaid-zenuml.core.mjs'),
  ...beside('@mermaid-js/mermaid-zenuml', 'dist/mermaid-zenuml.esm.mjs'),
  ...beside('@mermaid-js/mermaid-zenuml', 'dist/chunks/mermaid-zenuml.esm/*.mjs'),
  ...beside('@mermaid-js/layout-tidy-tree', 'package.json'),
  ...beside('@mermaid-js/layout-tidy-tree', 'dist/mermaid-layout-tidy-tree.core.mjs'),
  ...beside('@mermaid-js/layout-tidy-tree', 'dist/mermaid-layout-tidy-tree.esm.mjs'),
  ...beside('@mermaid-js/layout-tidy-tree', 'dist/chunks/mermaid-layout-tidy-tree.esm/*.mjs'),
  ...beside('@fortawesome/fontawesome-free', 'package.json'),
  ...beside('@fortawesome/fontawesome-free', 'css/{brands,regular,solid,fontawesome}.css'),
  ...beside('@fortawesome/fontawesome-free', 'webfonts/*'),
  ...beside('@fontsource-variable/recursive', 'package.json'),
  ...beside('@fontsource-variable/recursive', '*.css'),
  ...beside('@fontsource-variable/recursive', 'files/*'),
  ...beside('@fontsource/open-sans', 'package.json'),
  ...beside('@fontsource/open-sans', '{400,400-italic}.css'),
  ...beside('@fontsource/open-sans', 'files/*'),
  ...beside('katex', 'package.json'),
  ...beside('katex', 'dist/katex.css'),
  ...beside('katex', 'dist/fonts/*'),
  'node_modules/.pnpm/@mermaid-js+mermaid-cli@*/node_modules/@mermaid-js/mermaid-cli/dist/index.html',
  // The parser page's bundle, which lib/render/draw.ts resolves from the project root.
  'node_modules/mermaid/package.json',
  'node_modules/mermaid/dist/mermaid.min.js',
];

const config: NextConfig = {
  // Loaded from node_modules at runtime, not bundled. mermaid-cli in particular serialises functions into
  // the headless page; a bundler rewriting their dynamic import() breaks drawing. @sparticuz/chromium finds
  // its compressed browser next to its own module.
  serverExternalPackages: ['postgres', '@mermaid-js/mermaid-cli', 'puppeteer', 'mermaid', 'jsdom', 'dompurify', '@sparticuz/chromium'],
  outputFileTracingIncludes: { '/api/render/draw': DRAW_FILES },
  // The draw function carries a 70 MB browser; to stay well inside Vercel's 250 MB it drops what a route
  // that serves no page and optimises no image never loads: Next.js's source maps and development
  // runtimes, and sharp.
  outputFileTracingExcludes: {
    '/api/render/draw': ['**/next/dist/compiled/next-server/*.map', '**/next/dist/compiled/next-server/*.dev.js', '**/node_modules/@img/**', '**/node_modules/sharp/**'],
  },
  poweredByHeader: false,
  generateBuildId: () => BUILD_ID,
  env: { PBCP_BUILD_ID: BUILD_ID },
  // The pages' headers, with their per-request nonce CSP, are set in proxy.ts. The image routes (drawn
  // diagrams, the remote-image proxy) send their own image CSP.
  async headers() {
    const common = Object.entries(COMMON_HEADERS).map(([key, value]) => ({ key, value }));
    return [
      { source: '/api/:path((?!me/svg/|me/img).*)', headers: [{ key: 'Content-Security-Policy', value: API_CSP }, ...common] },
      { source: '/api/me/:path(svg/.*|img)', headers: common },
    ];
  },
};

export default config;
