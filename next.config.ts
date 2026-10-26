import type { NextConfig } from 'next';

const config: NextConfig = {
  // Producer markdown is never rendered in a browser (RFC §3.1); nothing here needs client bundling of @pbcp/*.
  serverExternalPackages: ['postgres'],
};

export default config;
