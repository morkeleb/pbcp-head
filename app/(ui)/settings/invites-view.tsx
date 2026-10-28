'use client';

// Settings → Invite requests: who asked for an invite at the front door's form (lib/invites.ts), with Delete. Only the
// deployment's own head is shown them.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PageRow } from '../chrome';
import { api, useOnline, when } from '../client';
import { call, errorText, PageError, Section } from './shared';

export function InvitesView() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageRow title="Invite requests" back={{ href: '/settings', label: 'Settings' }} />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-2 min-[900px]:px-6" data-settings-page="invites">
        <PageError error={error} />
        <InviteRequests onError={(e) => setError(errorText(e))} />
      </main>
    </>
  );
}

interface InviteRequest { id: string; email: string; created_at: string; user_agent: string | null }

/**
 * Who asked for an invite at the front door's form (lib/invites.ts): read-only, with Delete. Only the deployment's own
 * head is shown them; for any other the section is not there.
 */
function InviteRequests({ onError }: { onError: (e: unknown) => void }) {
  const [requests, setRequests] = useState<InviteRequest[] | null | undefined>(undefined);
  const online = useOnline();
  const load = useCallback(async () => {
    const r = await api<{ requests: InviteRequest[] }>('/api/me/settings/invites');
    setRequests(r.status === 200 ? r.body.requests : null);
  }, []);
  useEffect(() => void load(), [load]);
  if (requests === undefined) return <p className="pt-6 text-lead text-muted-foreground">Loading…</p>;
  if (requests === null) return <p className="pt-6 text-lead text-muted-foreground" data-invites-none>Only the deployment’s own head sees invite requests.</p>;
  const remove = async (id: string) => {
    try {
      await call(`/api/me/settings/invites/${encodeURIComponent(id)}`, 'DELETE');
    } catch (e) {
      onError(e);
    }
    await load();
  };
  return (
    <Section id="invites" title="Invite requests">
      {requests.length === 0 ? (
        <p className="text-lead text-muted-foreground">No one has asked yet.</p>
      ) : (
        <ul className="divide-y border-y text-body" data-invites>
          {requests.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2" data-invite={r.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate">{r.email}</p>
                <p className="truncate text-lead text-muted-foreground">{when(r.created_at)}{r.user_agent ? ` · ${r.user_agent}` : ''}</p>
              </div>
              <Button size="xs" variant="ghost" className="shrink-0 text-destructive" disabled={!online} onClick={() => void remove(r.id)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
