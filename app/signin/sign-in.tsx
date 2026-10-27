'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { loadTokens, saveTokens } from '../(ui)/client';

interface Tokens {
  access_token: string;
  refresh_token: string;
  device_id: string;
  head: string;
}


async function post(path: string, body: unknown, access?: string): Promise<any> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(access ? { authorization: `Session ${access}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
  return data;
}

export function SignIn({ enroll, apple }: { enroll: string | null; apple: boolean }) {
  const [session, setSession] = useState<Tokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSession(loadTokens());
  }, []);

  const keep = (t: Tokens | null) => {
    setSession(t);
    saveTokens(t);
    // Signed in: on to where the owner was going, or the brief.
    if (t) {
      const next = new URLSearchParams(location.search).get('next') ?? '';
      // Same-origin paths only: `//host` would leave the head.
      location.href = /^\/(?![/\\])/.test(next) ? next : '/brief';
    }
  };

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = run(async () => {
    const { options, state } = await post('/api/auth/passkey/login/options', {});
    const response = await startAuthentication({ optionsJSON: options });
    keep(await post('/api/auth/passkey/login', { state, response, platform: 'web', name: navigator.userAgent.slice(0, 60) }));
  });

  const registerPasskey = run(async () => {
    const { options, state } = await post('/api/auth/passkey/register/options', { enroll }, session?.access_token);
    const response = await startRegistration({ optionsJSON: options });
    keep(await post('/api/auth/passkey/register', { state, response, platform: 'web', name: navigator.userAgent.slice(0, 60) }));
  });

  const signOut = run(async () => {
    if (session) await post('/api/auth/logout', {}, session.access_token).catch(() => undefined);
    keep(null);
  });

  if (session) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-lead text-muted-foreground" data-testid="signed-in">
          Signed in to <strong className="font-semibold text-foreground">{session.head}</strong> on device <code>{session.device_id.slice(0, 8)}</code>.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild><a href="/brief">Open the brief</a></Button>
          <Button variant="outline" onClick={registerPasskey} disabled={busy}>Add another passkey</Button>
          <Button variant="ghost" className="text-muted-foreground" onClick={signOut} disabled={busy}>Sign out</Button>
        </div>
        {error && <p role="alert" className="text-lead text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {enroll ? (
        <Button onClick={registerPasskey} disabled={busy}>Create a passkey for this head</Button>
      ) : (
        <Button onClick={signIn} disabled={busy}>Sign in with a passkey</Button>
      )}
      {apple && <p className="text-lead text-muted-foreground">Sign in with Apple is configured for the app; its web button arrives with the web UI.</p>}
      {error && <p role="alert" className="text-lead text-destructive">{error}</p>}
    </div>
  );
}
