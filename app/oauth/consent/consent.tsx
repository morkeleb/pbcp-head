'use client';

// The request comes signed by the head (GET /api/oauth/authorize); it is decoded here only to show the app's name and
// where it will be sent back. POST /api/oauth/authorize verifies the signature and answers with where to go next.

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, loadTokens } from '../../(ui)/client';

interface Request {
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
}

function decode(token: string): Request | null {
  try {
    const payload = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    return (JSON.parse(json) as { req: Request }).req;
  } catch {
    return null;
  }
}

export function Consent() {
  const [token, setToken] = useState<string | null>(null);
  const [req, setReq] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(location.search).get('request');
    // Signed in first: the passkey is the owner's say-so; this page brings them back after.
    if (!loadTokens()) {
      location.replace(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    setToken(t);
    setReq(t ? decode(t) : null);
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

  if (token === null && req === null) return <p className="text-lead text-muted-foreground">…</p>;
  if (!req) return <p className="max-w-sm text-center text-lead text-destructive" role="alert">This request cannot be used. Start again from the app.</p>;
  const host = (() => {
    try {
      return new URL(req.redirect_uri).host;
    } catch {
      return req.redirect_uri;
    }
  })();
  return (
    <div className="flex max-w-sm flex-col items-center gap-4 text-center" data-consent>
      <p className="font-serif text-day font-semibold tracking-editorial" data-client-name>{req.client_name ?? 'An app'}</p>
      <p className="text-body">Allow this app to read your brief and record your decisions.</p>
      <p className="text-lead text-muted-foreground">
        It will act as you until you sign it out in Settings → Devices. You will be sent back to <span className="font-medium text-foreground">{host}</span>.
      </p>
      <div className="flex gap-2">
        <Button onClick={() => void answer(true)} disabled={busy} data-allow>Allow</Button>
        <Button variant="outline" onClick={() => void answer(false)} disabled={busy} data-deny>Deny</Button>
      </div>
      {error && <p className="text-lead text-destructive" role="alert">{error}</p>}
    </div>
  );
}
