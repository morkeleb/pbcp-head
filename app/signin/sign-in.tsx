'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
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
      <div>
        <p data-testid="signed-in">
          Signed in to <strong>{session.head}</strong> on device <code>{session.device_id.slice(0, 8)}</code>.
        </p>
        <a className="button" href="/brief">Open the brief</a>{' '}
        <button onClick={registerPasskey} disabled={busy}>Add another passkey</button>{' '}
        <button onClick={signOut} disabled={busy}>Sign out</button>
        {error && <p role="alert" style={{ color: '#b00' }}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      {enroll ? (
        <button onClick={registerPasskey} disabled={busy}>Create a passkey for this head</button>
      ) : (
        <button onClick={signIn} disabled={busy}>Sign in with a passkey</button>
      )}
      {apple && <p style={{ color: '#666', fontSize: 14 }}>Sign in with Apple is configured for the app; its web button arrives with the web UI.</p>}
      {error && <p role="alert" style={{ color: '#b00' }}>{error}</p>}
    </div>
  );
}
