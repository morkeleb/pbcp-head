// GET /manifest.webmanifest — the web app manifest: installable, standalone, opening on the brief.

import type { MetadataRoute } from 'next';

export const THEME_COLOR = '#7047f5';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/brief',
    name: 'PBCP head',
    short_name: 'Brief',
    description: 'Your brief: decisions, artifacts and signals from your producers.',
    start_url: '/brief',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: THEME_COLOR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
