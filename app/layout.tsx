import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// Every page is rendered per request, so Next.js can put proxy.ts's CSP nonce on its scripts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'head' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
