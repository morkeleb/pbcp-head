'use client';

// Identifying again (RFC 0.9 §4.1 `confirm`, §4.5 "Identifying again"): a card whose effective sensitivity is `confirm` is
// decided only after the person confirms with their passkey on this session (POST /api/auth/passkey/step-up). Choosing a
// control on such a card opens this sheet; its button runs the passkey, then the decision is recorded, in one gesture.
// The sheet is the head's own prompt: Safari lets a page ask for a passkey only from a tap, so the passkey starts from the
// sheet's button rather than after the decision's network call. Cancelling records nothing.

import { startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from './client';

type Pending = { title: string; resolve: (ok: boolean) => void };
let open: ((p: Pending) => void) | null = null;

/**
 * Asks the person to identify themselves again before deciding `title`. True once the head has stamped the session; false
 * when they cancel, or there is no prompt on the page (nothing is recorded then).
 */
export function requestStepUp(title: string): Promise<boolean> {
  return new Promise((resolve) => (open ? open({ title, resolve }) : resolve(false)));
}

/** The line beside a `confirm` card's controls (§4.5 "Identifying again": deciding will ask the person to identify themselves). */
export function ConfirmNote({ className }: { className?: string }) {
  return (
    <p className={className ?? 'text-meta text-muted-foreground'} data-confirm-note>
      Confirming asks for your passkey.
    </p>
  );
}

/** Mounted once in the UI layout; requestStepUp opens it. */
export function StepUpPrompt() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    open = (p) => {
      setError(null);
      setPending(p);
    };
    return () => void (open = null);
  }, []);

  const finish = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
    setBusy(false);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await api<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON']; state: string; message?: string }>('/api/auth/passkey/step-up/options', { method: 'POST', body: {} });
      if (o.status !== 200) throw new Error(o.body?.message ?? `the head answered ${o.status}`);
      const response = await startAuthentication({ optionsJSON: o.body.options });
      const v = await api<{ message?: string }>('/api/auth/passkey/step-up', { method: 'POST', body: { state: o.body.state, response } });
      if (v.status !== 200) throw new Error(v.body?.message ?? `the head answered ${v.status}`);
      finish(true);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error && e.name === 'NotAllowedError' ? 'The passkey was not used. Try again, or cancel.' : e instanceof Error ? e.message : 'The passkey could not be checked.');
    }
  };

  return (
    <Dialog open={pending !== null} onOpenChange={(o) => !o && !busy && finish(false)}>
      <DialogContent className="max-w-[22rem] gap-3 p-4" data-step-up>
        <DialogHeader>
          <DialogTitle className="font-serif text-title">Confirm it’s you</DialogTitle>
          <DialogDescription className="text-body">
            {pending ? <>“{pending.title}” asks you to confirm with your passkey before it is decided.</> : null}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-meta text-destructive" role="alert" data-step-up-error>{error}</p> : null}
        <DialogFooter className="gap-2">
          <Button variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => finish(false)} data-step-up-cancel>Cancel</Button>
          <Button disabled={busy} onClick={() => void confirm()} data-step-up-confirm>{busy ? 'Checking…' : 'Use passkey'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
