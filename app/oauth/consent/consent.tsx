'use client';

// The consent step. Nothing from the request parameter is shown until the head has verified it: the page asks
// GET /api/oauth/request for the client's name and the host it returns to, and POST /api/oauth/authorize records the
// answer. Both take the owner's own session; without one, the owner signs in with a passkey first and comes back here.

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, loadTokens } from '../../(ui)/client';

interface Verified {
  client_name: string | null;
  redirect_host: string;
}

export function Consent() {
  const [token, setToken] = useState<string | null>(null);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [state, setState] = useState<'checking' | 'ready' | 'refused'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loadTokens()) {
      location.replace(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const t = new URLSearchParams(location.search).get('request');
    setToken(t);
    void api<Verified>(`/api/oauth/request?request=${encodeURIComponent(t ?? '')}`).then((r) => {
      if (r.status === 200) {
        setVerified(r.body);
        setState('ready');
      } else setState('refused');
    });
  }, []);

  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ redirect?: string; error_description?: string; message?: string }>('/api/oauth/authorize', { method: 'POST', body: { request: token, allow } });
      if (r.status === 200 && r.body.redirect) {
        location.href = r.body.redirect;
        return;
      }
      setError(r.body.error_description ?? r.body.message ?? `the head answered ${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the request failed');
    }
    setBusy(false);
  };

  if (state === 'checking') return <p className="text-lead text-muted-foreground">…</p>;
  if (state === 'refused' || !verified) return <p className="max-w-sm text-center text-lead text-destructive" role="alert">This request cannot be used. Start again from the app.</p>;
  return (
    <div className="flex max-w-sm flex-col items-center gap-4 text-center" data-consent>
      <p className="font-serif text-day font-semibold tracking-editorial" data-client-name>{verified.client_name ?? 'An app'}</p>
      <p className="text-body">Allow this app to read your brief and record your decisions.</p>
      <p className="text-lead text-muted-foreground">
        It can read your brief and cards, and decide, acknowledge, snooze and give orders as you. It cannot see or change your settings, producers or devices.
        It keeps this until you sign it out in Settings → Devices. You will be sent back to{' '}
        <span className="font-medium text-foreground" data-redirect-host>{verified.redirect_host}</span>.
      </p>
      <div className="flex gap-2">
        <Button onClick={() => void answer(true)} disabled={busy} data-allow>Allow</Button>
        <Button variant="outline" onClick={() => void answer(false)} disabled={busy} data-deny>Deny</Button>
      </div>
      {error && <p className="text-lead text-destructive" role="alert">{error}</p>}
    </div>
  );
}
