'use client';

// Settings, under the shared masthead. Thin: everything it reads and changes goes through /api/me/settings/* (and
// /api/me/settings for the timezone), so the phone does the same. In order: this head, producers (tokens, ceilings,
// label ceilings), connecting a producer, devices, and this device's preferences.

import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { SNIPPET_TABS, TOKEN_PLACEHOLDER, type Snippets } from '../../../lib/settings/snippets';
import type { Density } from '../brief/DecisionCard';
import { PageRow, savedTheme, setTheme, useChrome, type ThemeChoice } from '../chrome';
import { api, OfflineError, saveTokens, useOnline, when } from '../client';
import { NOT_SENT, useDeferred } from '../components';

type Urgency = 'log' | 'brief' | 'immediate';
const URGENCIES: Urgency[] = ['log', 'brief', 'immediate'];

interface HeadFacts { owner: string; url: string; protocol: string; extensions: string[]; render: { mermaid: string[] } }
interface Token { id: string; root: string; instance: string | null; executor: boolean; ceiling: Urgency; created_at: string; last_used_at: string | null }
interface Label { label: string; cards: number; ceiling: Urgency | null }
interface Device { id: string; name: string | null; platform: string; last_seen_at: string | null; created_at: string; current: boolean }
interface HeadSettings { timezone: string; timezone_source: 'override' | 'device' | 'default'; timezone_override: string | null }

const field = 'rounded-md border border-input bg-background px-2 py-1 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const errorText = (e: unknown) => (e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed');

/** Writes through the settings API; a refusal or a lost connection is reported, never queued. */
async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await api<T & { message?: string }>(path, { method, ...(body !== undefined ? { body } : {}) });
  if (r.status >= 400) throw new Error(r.body?.message ?? `the head answered ${r.status}`);
  return r.body;
}

export function SettingsView() {
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ root: string; token: string } | null>(null);
  const report = (e: unknown) => setError(errorText(e));
  return (
    <>
      <PageRow title="Settings" />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-2 min-[900px]:px-6" data-settings>
        {error && <p className="mt-2 text-lead text-destructive" role="alert">{error}</p>}
        <ThisHead />
        <Producers onMinted={setMinted} minted={minted} onError={report} />
        <Connect minted={minted} />
        <Devices onError={report} />
        <Preferences onError={report} />
      </main>
    </>
  );
}

function Section({ id, title, children, intro }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="pt-8" aria-labelledby={id} data-section-settings={id}>
      <h3 id={id} className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">{title}</h3>
      {intro && <p className="pb-3 text-lead text-muted-foreground">{intro}</p>}
      {children}
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // no clipboard (an insecure origin, a denied permission): the text is selectable
    }
  };
  return (
    <Button variant="ghost" size="icon-xs" aria-label={done ? `Copied ${label}` : `Copy ${label}`} onClick={() => void copy()} data-copy={label}>
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

/** A value shown whole, selectable, with a copy control. */
function Copyable({ text, label, block = false, wrap = false }: { text: string; label: string; block?: boolean; wrap?: boolean }) {
  return block ? (
    <div className="relative rounded-md border bg-inset">
      {/* A token or a link wraps, whole and selectable; a snippet keeps its lines and scrolls. */}
      <pre className={cn('p-3 pr-10 text-[12px] leading-relaxed', wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto')} data-snippet={label}>{text}</pre>
      <div className="absolute right-1.5 top-1.5"><CopyButton text={text} label={label} /></div>
    </div>
  ) : (
    <span className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate text-body" data-value={label}>{text}</code>
      <CopyButton text={text} label={label} />
    </span>
  );
}

// --- 1. this head --------------------------------------------------------------------------------------------

function ThisHead() {
  const [facts, setFacts] = useState<HeadFacts | null>(null);
  useEffect(() => void api<HeadFacts>('/api/me/settings/head').then((r) => r.status === 200 && setFacts(r.body)), []);
  const rows: Array<[string, string, string]> = facts ? [['Owner id', facts.owner, 'owner id'], ['Head URL', facts.url, 'head URL'], ['Protocol', facts.protocol, 'protocol']] : [];
  return (
    <Section id="this-head" title="This head" intro="Producers submit cards to this URL with a producer token.">
      {!facts ? (
        <p className="text-lead text-muted-foreground">Loading…</p>
      ) : (
        <table className="w-full text-body">
          <tbody className="divide-y border-y">
            {rows.map(([k, v, label]) => (
              <tr key={k}>
                <th scope="row" className="w-28 py-2 pr-3 text-left align-middle font-normal text-muted-foreground">{k}</th>
                <td className="max-w-0 py-2"><Copyable text={v} label={label} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// --- 2. producers --------------------------------------------------------------------------------------------

function Producers({ minted, onMinted, onError }: { minted: { root: string; token: string } | null; onMinted: (m: { root: string; token: string }) => void; onError: (e: unknown) => void }) {
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
      onMinted({ root: r.producer.root, token: r.token });
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
    <Section id="producers" title="Producers" intro="Each producer holds a token bound to one root (§12); every card it sends has an id starting with that root. A ceiling is the furthest its cards may reach (§9).">
      {tokens === null ? (
        <p className="text-lead text-muted-foreground">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="text-lead text-muted-foreground">No producer has a token yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-body" data-producer-tokens>
            <thead>
              <tr className="text-left text-meta uppercase tracking-meta text-muted-foreground">
                <th className="pb-1 pr-3 font-normal">Root</th>
                <th className="pb-1 pr-3 font-normal">Created</th>
                <th className="pb-1 pr-3 font-normal">Last used</th>
                <th className="pb-1 pr-3 font-normal">Ceiling</th>
                <th className="pb-1 font-normal"><span className="sr-only">Revoke</span></th>
              </tr>
            </thead>
            <tbody className="divide-y border-y">
              {tokens.map((t) => (
                <tr key={t.id} data-token={t.root}>
                  <td className="py-2 pr-3 font-medium">{t.root}{t.instance && <span className="text-muted-foreground"> · {t.instance}</span>}{t.executor && <span className="text-lead text-muted-foreground"> · executor</span>}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{when(t.created_at)}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{t.last_used_at ? when(t.last_used_at) : 'never'}</td>
                  <td className="py-2 pr-3">
                    <select aria-label={`Ceiling for ${t.root}`} className={field} value={t.ceiling} disabled={!online}
                      onChange={(e) => void act(() => call(`/api/me/settings/producers/${t.id}`, 'PATCH', { ceiling: e.target.value }))}>
                      {URGENCIES.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </td>
                  <td className="py-2 text-right">
                    <Button size="xs" variant="ghost" className="text-destructive" disabled={!online || deferred.pending}
                      onClick={() => deferred.schedule(`Revoking ${t.root}’s token`, () => void act(() => call(`/api/me/settings/producers/${t.id}`, 'DELETE')))}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="mt-3 flex flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) void mint(); }} data-new-producer>
        <label className="flex flex-col gap-1">
          <span className="sr-only">New producer’s root</span>
          <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="root, e.g. n8n" aria-label="New producer’s root" className={cn(field, 'w-48')} autoComplete="off" spellCheck={false} />
        </label>
        <Button type="submit" size="sm" disabled={!online || busy || !valid}>New producer</Button>
        {rootError && <p className="basis-full text-lead text-destructive" role="alert">{rootError}</p>}
      </form>
      {minted && (
        <div className="mt-3 rounded-lg border border-ring p-3" data-minted>
          <p className="pb-2 text-lead">
            The token for <strong className="font-semibold">{minted.root}</strong>. This is the only time it is shown: the head keeps only its hash.
          </p>
          <Copyable text={minted.token} label="token" block wrap />
        </div>
      )}

      <h4 className="pb-2 pt-6 text-meta font-semibold uppercase tracking-meta text-muted-foreground">Ceilings by label</h4>
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
      <p className="pt-2 text-lead text-muted-foreground">A card under a producer’s ceiling and a label’s takes the lower. Changes apply to cards stored from now on.</p>
      {deferred.toast}
    </Section>
  );
}

// --- 3. connect a producer -------------------------------------------------------------------------------------

function Connect({ minted }: { minted: { root: string; token: string } | null }) {
  const [s, setS] = useState<(Snippets & { token: string }) | null>(null);
  const root = minted?.root ?? 'my-producer';
  useEffect(() => {
    void api<Snippets & { token: string }>(`/api/me/settings/snippets?root=${encodeURIComponent(root)}`).then((r) => r.status === 200 && setS(r.body));
  }, [root]);
  // The token just minted, while this page is open; the placeholder once it has been shown and the page left.
  const fill = (text: string) => (minted && s ? text.split(s.token).join(minted.token) : text);
  return (
    <Section id="connect" title="Connect a producer" intro={minted ? `Filled in with ${minted.root}’s token.` : `Mint a token above and it is filled in here; until then the snippets say ${TOKEN_PLACEHOLDER}.`}>
      {!s ? (
        <p className="text-lead text-muted-foreground">Loading…</p>
      ) : (
        <Tabs defaultValue="curl">
          <TabsList>
            {SNIPPET_TABS.map((t) => <TabsTrigger key={t.key} value={t.key} className="px-3 text-control">{t.label}</TabsTrigger>)}
          </TabsList>
          {SNIPPET_TABS.map((t) => (
            <TabsContent key={t.key} value={t.key} className="mt-2">
              <Copyable text={fill(s[t.key])} label={t.key} block />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </Section>
  );
}

// --- 4. devices ------------------------------------------------------------------------------------------------

function Devices({ onError }: { onError: (e: unknown) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);
  const online = useOnline();
  const load = useCallback(async () => {
    const r = await api<{ devices: Device[] }>('/api/me/settings/devices');
    if (r.status === 200) setDevices(r.body.devices);
  }, []);
  useEffect(() => void load(), [load]);
  const signOut = async (d: Device) => {
    try {
      await call(`/api/me/settings/devices/${encodeURIComponent(d.id)}`, 'DELETE');
      if (d.current) {
        saveTokens(null);
        location.href = '/signin';
        return;
      }
    } catch (e) {
      onError(e);
    }
    await load();
  };
  const enrol = async () => {
    try {
      setLink(await call('/api/me/settings/enrolment', 'POST'));
    } catch (e) {
      onError(e);
    }
  };
  return (
    <Section id="devices" title="Devices" intro="Where you are signed in. Signing a device out ends its session there.">
      {devices === null ? (
        <p className="text-lead text-muted-foreground">Loading…</p>
      ) : (
        <table className="w-full text-body" data-devices>
          <thead>
            <tr className="text-left text-meta uppercase tracking-meta text-muted-foreground">
              <th className="pb-1 pr-3 font-normal">Name</th>
              <th className="pb-1 pr-3 font-normal">Platform</th>
              <th className="pb-1 pr-3 font-normal">Last seen</th>
              <th className="pb-1 font-normal"><span className="sr-only">Sign out</span></th>
            </tr>
          </thead>
          <tbody className="divide-y border-y">
            {devices.map((d) => (
              <tr key={d.id} data-device={d.id}>
                <td className="py-2 pr-3">
                  {d.name ?? 'Unnamed device'}
                  {d.current && <span className="ml-2 rounded-full border px-1.5 text-meta text-muted-foreground" data-this-device>this device</span>}
                </td>
                <td className="py-2 pr-3 text-muted-foreground">{d.platform}</td>
                <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{d.last_seen_at ? when(d.last_seen_at) : '—'}</td>
                <td className="py-2 text-right">
                  <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={!online} onClick={() => void signOut(d)}>Sign out</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-3">
        <Button size="sm" variant="outline" disabled={!online} onClick={() => void enrol()}>Enrol another device</Button>
      </div>
      {link && (
        <div className="mt-3" data-enrolment>
          <p className="pb-2 text-lead text-muted-foreground">Open this on the other device before {when(link.expires_at)} to register a passkey there.</p>
          <Copyable text={link.url} label="enrolment link" block wrap />
        </div>
      )}
    </Section>
  );
}

// --- 5. preferences ----------------------------------------------------------------------------------------------

function Preferences({ onError }: { onError: (e: unknown) => void }) {
  const { density, setDensity } = useChrome();
  const [theme, setThemeState] = useState<ThemeChoice>('system');
  const [head, setHead] = useState<HeadSettings | null>(null);
  const [zone, setZone] = useState('');
  const online = useOnline();
  useEffect(() => setThemeState(savedTheme()), []);
  const load = useCallback(async () => {
    const r = await api<HeadSettings>('/api/me/settings');
    if (r.status === 200) {
      setHead(r.body);
      setZone(r.body.timezone_override ?? '');
    }
  }, []);
  useEffect(() => void load(), [load]);
  const saveZone = async (value: string | null) => {
    try {
      await call('/api/me/settings', 'PATCH', { timezone: value });
    } catch (e) {
      onError(e);
    }
    await load();
  };
  const row = (label: string, control: ReactNode, note?: string) => (
    <tr>
      <th scope="row" className="w-28 py-2 pr-3 text-left align-top font-normal text-muted-foreground">{label}</th>
      <td className="py-2">
        {control}
        {note && <p className="pt-1 text-lead text-muted-foreground">{note}</p>}
      </td>
    </tr>
  );
  return (
    <Section id="preferences" title="Preferences" intro="Density and theme are this device’s; the timezone is the head’s.">
      <table className="w-full text-body" data-preferences>
        <tbody className="divide-y border-y">
          {row(
            'Density',
            <select aria-label="Density" className={field} value={density} onChange={(e) => setDensity(e.target.value as Density)}>
              <option value="comfortable">Comfortable</option>
              <option value="ledger">Ledger</option>
            </select>,
          )}
          {row(
            'Theme',
            <select aria-label="Theme" className={field} value={theme} onChange={(e) => { setTheme(e.target.value as ThemeChoice); setThemeState(e.target.value as ThemeChoice); }}>
              <option value="system">As the system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>,
          )}
          {row(
            'Timezone',
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveZone(zone.trim() || null); }}>
              <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder={head?.timezone ?? 'Europe/Copenhagen'} aria-label="Timezone override" className={cn(field, 'w-52')} spellCheck={false} />
              <Button type="submit" size="xs" variant="outline" disabled={!online}>Set</Button>
              {head?.timezone_override && <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" disabled={!online} onClick={() => void saveZone(null)}>Follow my devices</Button>}
            </form>,
            head ? (head.timezone_source === 'override' ? `Set here: ${head.timezone}.` : `${head.timezone}, ${head.timezone_source === 'device' ? 'from the device you used last' : 'until a device says otherwise'}.`) : undefined,
          )}
        </tbody>
      </table>
    </Section>
  );
}
