import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { THEME_COLOR } from './manifest';
import { ServiceWorker } from './service-worker';

// Every page is rendered per request, so Next.js can put proxy.ts's CSP nonce on its scripts.
export const dynamic = 'force-dynamic';

// The manifest (app/manifest.ts) is linked by Next.js. iOS Safari's "Add to Home Screen" reads the apple-*
// tags instead: a 180×180 opaque icon, and a standalone window with the title below the icon.
export const metadata: Metadata = {
  title: 'head',
  applicationName: 'PBCP head',
  appleWebApp: { capable: true, title: 'Brief', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: THEME_COLOR };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
