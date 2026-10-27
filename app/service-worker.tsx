'use client';

// Registers the service worker (app/sw.js, lib/pwa/service-worker.ts) on every page.

import { useEffect } from 'react';

export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
