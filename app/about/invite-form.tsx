'use client';

// "Request an invite": a plain form that posts to /api/invite, so it works without JavaScript (the route answers a form
// post with a redirect back to `/?invite=requested`). With JavaScript it posts JSON and says what happened in place.

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function InviteForm({ requested }: { requested: boolean }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | string>(requested ? 'done' : 'idle');
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    setState('sending');
    try {
      const r = await fetch('/api/invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      if (r.status === 202) return setState('done');
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setState(r.status === 429 ? 'Too many requests from here just now; try again in a while.' : body.error === 'invalid_email' ? 'That doesn’t look like an email address.' : 'That didn’t go through; try again.');
    } catch {
      setState('That didn’t go through; check your connection and try again.');
    }
  };
  if (state === 'done') {
    return <p className="text-body text-foreground" role="status" data-invite-done>Thanks — your request is in. We’ll write when there’s a place for you.</p>;
  }
  const error = state !== 'idle' && state !== 'sending' ? state : null;
  return (
    <form method="post" action="/api/invite" onSubmit={(e) => void submit(e)} className="flex w-full flex-col gap-2 min-[560px]:flex-row" data-invite-form>
      <label className="sr-only" htmlFor="invite-email">Email</label>
      <input
        id="invite-email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" maxLength={254}
        className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button type="submit" className="h-10" disabled={state === 'sending'}>Request an invite</Button>
      {error && <p className="basis-full text-lead text-destructive" role="alert">{error}</p>}
    </form>
  );
}
