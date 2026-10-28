'use client';

// Registers the service worker (app/sw.js, lib/pwa/service-worker.ts) on every page, and says when a new version is
// ready. Each deployment is a new worker that takes over at once (skipWaiting, clients.claim), but a page already open
// keeps running the code it loaded: when the worker controlling it changes, the page offers a reload. The browser looks
// for a new worker only on a navigation, which an app left open on a phone may not make for days, so the page also asks
// whenever it comes back to the foreground (at most once a minute) and every hour while it is open.

import { useEffect, useState } from 'react';

const CHECK_EVERY_MS = 60 * 60 * 1000;
const AT_MOST_EVERY_MS = 60 * 1000;

export function ServiceWorker() {
  const [update, setUpdate] = useState(false);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;
    // A first install also changes the controller (from none): that is not an update.
    let controlled = sw.controller !== null;
    const changed = () => {
      if (controlled) setUpdate(true);
      controlled = true;
    };
    sw.addEventListener('controllerchange', changed);
    let last = Date.now();
    const check = () => {
      if (Date.now() - last < AT_MOST_EVERY_MS) return;
      last = Date.now();
      void sw.getRegistration('/').then((r) => r?.update()).catch(() => undefined);
    };
    const onVisible = () => void (document.visibilityState === 'visible' && check());
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      last = 0;
      check();
    }, CHECK_EVERY_MS);
    sw.register('/sw.js', { scope: '/' }).catch(() => undefined);
    return () => {
      sw.removeEventListener('controllerchange', changed);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, []);
  if (!update) return null;
  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-[560px] items-center gap-3 rounded-md bg-foreground px-3 py-2.5 text-lead text-background" role="status" data-update-available>
      <span className="flex-1">A new version of Brief is ready.</span>
      <button type="button" className="font-semibold underline underline-offset-2" onClick={() => location.reload()}>Reload</button>
      <button type="button" className="opacity-70" aria-label="Later" onClick={() => setUpdate(false)}>Later</button>
    </div>
  );
}
