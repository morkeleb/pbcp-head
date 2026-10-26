import type { NextConfig } from 'next';

const config: NextConfig = {
  // Loaded from node_modules at runtime, not bundled. mermaid-cli in particular serialises functions into
  // the headless page; a bundler rewriting their dynamic import() breaks drawing.
  serverExternalPackages: ['postgres', '@mermaid-js/mermaid-cli', 'puppeteer', 'mermaid', 'jsdom', 'dompurify'],
};

export default config;
