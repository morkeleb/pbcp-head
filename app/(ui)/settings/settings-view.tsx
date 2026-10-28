'use client';

// Settings, under the shared masthead. Thin: everything it reads and changes goes through /api/me/settings/* (and
// /api/me/settings for the timezone), so the phone does the same. In order: this head, producers (tokens, ceilings,
// label ceilings), connecting a producer, devices, and this device's preferences.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PAIRING_CODE_SHAPE } from '../../../lib/pairing-code';
import type { Density } from '../brief/DecisionCard';
import { Copyable } from '../copy';
import { DeviceNotifications, type NotificationState } from './notifications';
import { ProducerName } from './producer-name';
import { PageRow, setTheme, useChrome, useThemeChoice, type ThemeChoice } from '../chrome';
import { api, OfflineError, saveTokens, useOnline, when } from '../client';
import { NOT_SENT, useDeferred } from '../components';

type Urgency = 'log' | 'brief' | 'immediate';
const URGENCIES: Urgency[] = ['log', 'brief', 'immediate'];

interface HeadFacts { owner: string; url: string; protocol: string; extensions: string[]; render: { mermaid: string[] } }
interface Token {
  id: string; root: string; name: string | null; instance: string | null; executor: boolean; ceiling: Urgency; created_at: string; last_used_at: string | null;
  paired: { name: string | null; address: string | null; at: string } | null;
}
interface OpenCode { id: string; created_at: string; expires_at: string }
interface Label { label: string; cards: number; ceiling: Urgency | null }
interface Device extends NotificationState { id: string; name: string | null; platform: string; last_seen_at: string | null; created_at: string; current: boolean }
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
        <InviteRequests onError={report} />
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
                <td className="max-w-0 py-2"><Copyable text={v} label={label} wrap /></td>
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
      {minted && (
        <div className="mt-3 rounded-lg border border-ring p-3" data-minted>
          <p className="pb-2 text-lead">
            The token for <strong className="font-semibold">{minted.root}</strong>. This is the only time it is shown: the head keeps only its hash.
          </p>
          <Copyable text={minted.token} label="token" block wrap />
        </div>
      )}

      <Pairing onPaired={load} onError={onError} />

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
        <span className="text-lead text-muted-foreground">An agent mints its own token with a code: {PAIRING_CODE_SHAPE}. Valid 10 minutes, once.</span>
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

// --- 3. connect a producer -------------------------------------------------------------------------------------

interface Connection {
  api: string;
  owner: string;
  token: string;
  config: Record<string, string>;
  curl: string;
  curl_root: string;
  connectors: Array<{ name: string; url: string }>;
}

/**
 * The three values a producer needs and a curl that PUTs a card (@pbcp/client's producerConfig and curlSnippet, served
 * by /api/me/settings/snippets), for the token just minted; each connector's own setup is in its README, by link. The
 * curl's card is under the minted root, so the command works with that token; with none minted, the §3 example
 * (root hermes) and the placeholder.
 */
function Connect({ minted }: { minted: { root: string; token: string } | null }) {
  const [c, setC] = useState<Connection | null>(null);
  useEffect(() => {
    void api<Connection>(`/api/me/settings/snippets${minted ? `?root=${encodeURIComponent(minted.root)}` : ''}`).then((r) => r.status === 200 && setC(r.body));
  }, [minted]);
  // The token just minted, while this page is open; the placeholder once it has been shown and the page left.
  const fill = (text: string) => (minted && c ? text.split(c.token).join(minted.token) : text);
  return (
    <Section
      id="connect"
      title="Connect a producer"
      intro={
        <>
          {minted ? `Filled in with ${minted.root}’s token.` : `Mint a token above and it is filled in here; until then these say ${c?.token ?? '<token>'}.`}{' '}
          Or pair instead: make a code with “Pair a producer” and give it to the agent, which mints its own token (
          <a href="/connect" className="underline decoration-border underline-offset-2">how it works</a>).
        </>
      }
    >
      {!c ? (
        <p className="text-lead text-muted-foreground">Loading…</p>
      ) : (
        <div data-connect>
          <table className="w-full text-body" data-producer-config>
            <tbody className="divide-y border-y">
              {Object.entries(c.config).map(([k, v]) => (
                <tr key={k}>
                  <th scope="row" className="w-40 py-2 pr-3 text-left align-middle font-normal"><code className="text-lead text-muted-foreground">{k}</code></th>
                  <td className="max-w-0 py-2"><Copyable text={fill(v)} label={k} wrap /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pb-2 pt-4 text-lead text-muted-foreground">
            A first card with curl. Its id is under the root <code>{c.curl_root}</code>, so it needs a token for that root (§12).
          </p>
          <Copyable text={fill(c.curl)} label="curl" block />
          <p className="pb-1 pt-4 text-lead text-muted-foreground">Each connector’s setup, with these three values:</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-body" data-connectors>
            {c.connectors.map((l) => (
              <li key={l.name}>
                <a href={l.url} target="_blank" rel="noopener" className="underline decoration-border underline-offset-2 hover:decoration-foreground">{l.name}</a>
              </li>
            ))}
          </ul>
        </div>
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
    <Section id="devices" title="Devices" intro="Where you are signed in, and the assistants you allowed to use your brief. Signing one out ends its access there and then.">
      {devices === null ? (
        <p className="text-lead text-muted-foreground">Loading…</p>
      ) : (
        <ul className="divide-y border-y text-body" data-devices>
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 py-2" data-device={d.id}>
              <div className="min-w-0 flex-1">
                <p>
                  {d.name ?? 'Unnamed device'}
                  {d.current && <span className="ml-2 whitespace-nowrap rounded-full border px-1.5 text-meta text-muted-foreground" data-this-device>this device</span>}
                </p>
                <p className="text-lead text-muted-foreground">
                  {d.platform === 'mcp' ? 'assistant' : d.platform} · last seen {d.last_seen_at ? when(d.last_seen_at) : '—'}
                </p>
              </div>
              <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground" disabled={!online} onClick={() => void signOut(d)}>Sign out</Button>
              {/* Web Push reaches the web app; an assistant has no screen, and the phone app will use its own channel. */}
              {d.platform === 'web' && <DeviceNotifications deviceId={d.id} current={d.current} state={d} online={online} onChanged={load} onError={onError} />}
            </li>
          ))}
        </ul>
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
  const theme = useThemeChoice();
  const [head, setHead] = useState<HeadSettings | null>(null);
  const [zone, setZone] = useState('');
  const online = useOnline();
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
            <select aria-label="Theme" className={field} value={theme} onChange={(e) => setTheme(e.target.value as ThemeChoice)}>
              <option value="system">System</option>
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

// --- 6. invite requests ------------------------------------------------------------------------------------------

interface InviteRequest { id: string; email: string; created_at: string; user_agent: string | null }

/**
 * Who asked for an invite at the front door's form (lib/invites.ts): read-only, with Delete. Only the deployment's own
 * head is shown them; for any other the section is not there.
 */
function InviteRequests({ onError }: { onError: (e: unknown) => void }) {
  const [requests, setRequests] = useState<InviteRequest[] | null>(null);
  const online = useOnline();
  const load = useCallback(async () => {
    const r = await api<{ requests: InviteRequest[] }>('/api/me/settings/invites');
    setRequests(r.status === 200 ? r.body.requests : null);
  }, []);
  useEffect(() => void load(), [load]);
  if (requests === null) return null;
  const remove = async (id: string) => {
    try {
      await call(`/api/me/settings/invites/${encodeURIComponent(id)}`, 'DELETE');
    } catch (e) {
      onError(e);
    }
    await load();
  };
  return (
    <Section id="invites" title="Invite requests" intro="Addresses that asked for an invite at the front door. Nothing is sent to them.">
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
