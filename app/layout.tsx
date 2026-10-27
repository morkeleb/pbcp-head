import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { editorialFont, interfaceFont } from '../lib/fonts';
import { NAME } from '../lib/masthead';
import './globals.css';
import { THEME_COLOR } from './manifest';
import { ServiceWorker } from './service-worker';

// Every page is rendered per request, so Next.js can put proxy.ts's CSP nonce on its scripts.
export const dynamic = 'force-dynamic';

// The manifest (app/manifest.ts) is linked by Next.js. iOS Safari's "Add to Home Screen" reads the apple-*
// tags instead: a 180×180 opaque icon, and a standalone window with the title below the icon.
export const metadata: Metadata = {
  title: { default: NAME, template: `%s · ${NAME}` },
  applicationName: NAME,
  appleWebApp: { capable: true, title: 'Brief', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: THEME_COLOR };

/**
 * The theme before first paint: the device's saved choice (masthead toggle, `pbcp.theme`), else the system's. Inline,
 * with this request's CSP nonce, so a dark page never flashes light.
 */
const THEME = `try{var t=localStorage.getItem('pbcp.theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" className={`${interfaceFont.variable} ${editorialFont.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
