'use client';

// Settings → Producers: the producers' tokens (each row's name edited in place, its root, instance, when it was paired,
// made and last used, its ceiling, Revoke), a new producer (the token shown once, with the three values filled in), a
// pairing code for an agent to mint its own, and ceilings by label. What it all means is on /connect.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageRow } from '../chrome';
import { api, useOnline, when } from '../client';
import { useDeferred } from '../components';
import { Copyable } from '../copy';
import { ProducerName } from './producer-name';
import { call, ConnectLink, errorText, field, PageError, Section, URGENCIES, type Urgency } from './shared';

interface Token {
  id: string; root: string; name: string | null; instance: string | null; executor: boolean; ceiling: Urgency; created_at: string; last_used_at: string | null;
  paired: { name: string | null; address: string | null; at: string } | null;
}
interface OpenCode { id: string; created_at: string; expires_at: string }
interface Label { label: string; cards: number; ceiling: Urgency | null }

export function ProducersView() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageRow title="Producers" back={{ href: '/settings', label: 'Settings' }} />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-2 min-[900px]:px-6" data-settings-page="producers">
        <PageError error={error} />
        <Producers onError={(e) => setError(errorText(e))} />
      </main>
    </>
  );
}

/**
 * The token just minted, this once (the head keeps only its hash), with the three values a producer needs filled in
 * (GET /api/me/settings/snippets for its root). The rest, the first card and each connector's setup, is on /connect.
 */
function Minted({ minted }: { minted: { root: string; token: string } }) {
  const [config, setConfig] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    void api<{ config: Record<string, string>; token: string }>(`/api/me/settings/snippets?root=${encodeURIComponent(minted.root)}`).then((r) => {
      if (r.status === 200) setConfig(Object.fromEntries(Object.entries(r.body.config).map(([k, v]) => [k, v.split(r.body.token).join(minted.token)])));
    });
  }, [minted]);
  return (
    <div className="mt-3 rounded-lg border border-ring p-3" data-minted>
      <p className="pb-2 text-lead">
        The token for <strong className="font-semibold">{minted.root}</strong>. This is the only time it is shown: the head keeps only its hash.
      </p>
      <Copyable text={minted.token} label="token" block wrap />
      {config && (
        <table className="mt-3 w-full text-body" data-producer-config>
          <tbody className="divide-y border-y">
            {Object.entries(config).map(([k, v]) => (
              <tr key={k}>
                <th scope="row" className="w-40 py-2 pr-3 text-left align-middle font-normal"><code className="text-lead text-muted-foreground">{k}</code></th>
                <td className="max-w-0 py-2"><Copyable text={v} label={k} wrap /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ConnectLink section="producer">The first card and each connector’s setup, with these values</ConnectLink>
    </div>
  );
}

function Producers({ onError }: { onError: (e: unknown) => void }) {
  const [minted, setMinted] = useState<{ root: string; token: string } | null>(null);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [root, setRoot] = useState('');
  const [rootError, setRootError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const deferred = useDeferred();

  const load = useCallback(async () => {
    const [t, l] = await Promise.all([api<{ producers: Token[] }>('/api/me/settings/producers'), api<{ labels: Label[] }>('/api/me/settings/labels')]);
    if (t.status === 200) setTokens(t.body.producers);
    if (l.status === 200) setLabels(l.body.labels);
  }, []);
  useEffect(() => void load(), [load]);

  const mint = async () => {
    setBusy(true);
    setRootError(null);
    try {
      const r = await call<{ token: string; producer: Token }>('/api/me/settings/producers', 'POST', { root: root.trim() });
      setMinted({ root: r.producer.root, token: r.token });
      setRoot('');
      await load();
    } catch (e) {
      setRootError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      onError(e);
    }
    await load();
  };
  const valid = /^[A-Za-z0-9-]{1,64}$/.test(root.trim()) && root.trim() !== 'head';

  return (
    <Section id="producers" title="Producers">
      {tokens === null ? (
        <p className="text-lead text-muted-foreground">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="text-lead text-muted-foreground">No producer has a token yet.</p>
      ) : (
        // Rows that wrap rather than a table: at a phone's width a table squeezed the root to a letter a line.
        <ul className="divide-y border-y text-body" data-producer-tokens>
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-token={t.root}>
              <div className="min-w-0 flex-1 basis-56">
                <p className="font-medium" data-root>
                  <ProducerName name={t.name} root={t.root} disabled={!online} onSave={(name) => call(`/api/me/settings/producers/${t.id}`, 'PATCH', { name }).then(load)} />
                  {t.name !== null && t.name !== t.root && <span className="font-normal text-muted-foreground"> · {t.root}</span>}
                  {t.instance && <span className="text-muted-foreground"> · {t.instance}</span>}{t.executor && <span className="text-lead text-muted-foreground"> · executor</span>}
                </p>
                {t.paired && (
                  <p className="text-lead text-muted-foreground" data-paired>
                    paired{t.paired.name && t.paired.name !== t.name ? ` as ${t.paired.name}` : ''} · {when(t.paired.at)}{t.paired.address ? ` · ${t.paired.address}` : ''}
                  </p>
                )}
                <p className="text-lead text-muted-foreground">
                  created {when(t.created_at)} · last used {t.last_used_at ? when(t.last_used_at) : 'never'}
                </p>
              </div>
              <label className="flex items-center gap-2">
                <span className="text-meta uppercase tracking-meta text-muted-foreground">Ceiling</span>
                <select aria-label={`Ceiling for ${t.root}`} className={field} value={t.ceiling} disabled={!online}
                  onChange={(e) => void act(() => call(`/api/me/settings/producers/${t.id}`, 'PATCH', { ceiling: e.target.value }))}>
                  {URGENCIES.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
              <Button size="xs" variant="ghost" className="ml-auto text-destructive" disabled={!online || deferred.pending}
                onClick={() => deferred.schedule(`Revoking ${t.root}’s token`, () => void act(() => call(`/api/me/settings/producers/${t.id}`, 'DELETE')))}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form className="mt-3 flex flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) void mint(); }} data-new-producer>
        <label className="flex flex-col gap-1">
          <span className="sr-only">New producer’s root</span>
          <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="root, e.g. n8n" aria-label="New producer’s root" className={cn(field, 'w-48')} autoComplete="off" spellCheck={false} />
        </label>
        <Button type="submit" size="sm" disabled={!online || busy || !valid}>New producer</Button>
        {rootError && <p className="basis-full text-lead text-destructive" role="alert">{rootError}</p>}
      </form>
      {minted && <Minted minted={minted} />}

      <Pairing onPaired={load} onError={onError} />

      <h4 className="pb-2 pt-6 text-meta font-semibold uppercase tracking-meta text-muted-foreground" data-label-ceilings-title>Ceilings by label</h4>
      {labels === null ? null : labels.length === 0 ? (
        <p className="text-lead text-muted-foreground">No card carries a label yet.</p>
      ) : (
        <table className="w-full text-body" data-label-ceilings>
          <tbody className="divide-y border-y">
            {labels.map((l) => (
              <tr key={l.label}>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {l.label} <span className="text-lead text-muted-foreground">· {l.cards} {l.cards === 1 ? 'card' : 'cards'}</span>
                </th>
                <td className="py-2 text-right">
                  <select aria-label={`Ceiling for label ${l.label}`} className={field} value={l.ceiling ?? ''} disabled={!online}
                    onChange={(e) => void act(() => call(`/api/me/settings/labels/${encodeURIComponent(l.label)}`, 'PATCH', { ceiling: e.target.value || null }))}>
                    <option value="">no ceiling</option>
                    {URGENCIES.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ConnectLink section="producer">How a producer connects: the first card, pairing and each connector’s setup</ConnectLink>
      {deferred.toast}
    </Section>
  );
}

/**
 * Pairing (lib/settings/pairing.ts): a code to give an agent, which mints its own token with it at POST /api/pair. The
 * code is shown when it is made and never again (only its hash is kept); open codes are listed by when they expire,
 * each with Cancel.
 */
function Pairing({ onPaired, onError }: { onPaired: () => void; onError: (e: unknown) => void }) {
  const [codes, setCodes] = useState<OpenCode[]>([]);
  const [made, setMade] = useState<{ id: string; code: string; say: string; expires_at: string } | null>(null);
  const online = useOnline();
  const load = useCallback(async () => {
    const r = await api<{ codes: OpenCode[] }>('/api/me/settings/pairing');
    if (r.status === 200) setCodes(r.body.codes);
  }, []);
  useEffect(() => void load(), [load]);
  // A code that is no longer open was used (or expired): the producer list may have a new row.
  useEffect(() => {
    if (made && !codes.some((c) => c.id === made.id)) onPaired();
  }, [codes, made, onPaired]);
  useEffect(() => {
    if (!made) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [made, load]);
  const create = async () => {
    try {
      setMade(await call('/api/me/settings/pairing', 'POST'));
    } catch (e) {
      onError(e);
    }
    await load();
  };
  const cancel = async (id: string) => {
    try {
      await call(`/api/me/settings/pairing/${id}`, 'DELETE');
      if (made?.id === id) setMade(null);
    } catch (e) {
      onError(e);
    }
    await load();
  };
  const open = (id: string) => codes.some((c) => c.id === id);
  return (
    <div className="mt-5" data-pairing>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!online} onClick={() => void create()}>Pair a producer</Button>
      </div>
      {made && open(made.id) && (
        <div className="mt-3 rounded-lg border border-ring p-3" data-pairing-code>
          <p className="font-mono text-[22px] font-semibold tracking-[0.15em]" data-code>{made.code}</p>
          <p className="pb-2 pt-1 text-lead text-muted-foreground">Give the agent this, before {when(made.expires_at)}:</p>
          <Copyable text={made.say} label="pairing sentence" block wrap />
        </div>
      )}
      {codes.length > 0 && (
        <ul className="mt-3 divide-y border-y text-body" data-open-codes>
          {codes.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-muted-foreground">
                {made?.id === c.id ? <span className="font-mono text-foreground">{made.code}</span> : 'A code'} · made {when(c.created_at)}, open until {when(c.expires_at)}
              </span>
              <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={!online} onClick={() => void cancel(c.id)}>Cancel</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

