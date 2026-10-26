import type { NextConfig } from 'next';

const config: NextConfig = {
  // Loaded from node_modules at runtime, not bundled. mermaid-cli in particular serialises functions into
  // the headless page; a bundler rewriting their dynamic import() breaks drawing.
  serverExternalPackages: ['postgres', '@mermaid-js/mermaid-cli', 'puppeteer', 'mermaid', 'jsdom', 'dompurify'],
  async headers() {
    // Card HTML is sanitised on the server; this is the second line. Images come only from the head itself
    // (diagrams, the remote-image proxy) or data: URIs, so a body can never make the browser call out.
    const production = process.env.NODE_ENV === 'production';
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ');
    return [{ source: '/:path((?!api/).*)', headers: [{ key: 'Content-Security-Policy', value: csp }, { key: 'Referrer-Policy', value: 'no-referrer' }] }];
  },
};

export default config;
