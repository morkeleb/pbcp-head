'use client';

// Settings → Devices: where the owner is signed in and the assistants they allowed (name, platform, last seen, this
// device, Sign out), this device's notifications, enrolling another device, and the MCP URL an assistant connects to.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PageRow } from '../chrome';
import { api, saveTokens, useOnline, when } from '../client';
import { Copyable } from '../copy';
import { DeviceNotifications, type NotificationState } from './notifications';
import { call, ConnectLink, errorText, PageError, Section } from './shared';

interface Device extends NotificationState { id: string; name: string | null; platform: string; last_seen_at: string | null; created_at: string; current: boolean }

export function DevicesView() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageRow title="Devices" back={{ href: '/settings', label: 'Settings' }} />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-2 min-[900px]:px-6" data-settings-page="devices">
        <PageError error={error} />
        <Devices onError={(e) => setError(errorText(e))} />
      </main>
    </>
  );
}

/** "Connect an assistant": the head's MCP URL, to paste into an assistant; how, for each, is on /connect. */
function Assistant() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => setUrl(`${location.origin}/api/mcp`), []);
  return (
    <div className="mt-6 border-t pt-4" data-connect-assistant>
      <p className="pb-2 text-body">Connect an assistant</p>
      {url && <Copyable text={url} label="mcp" wrap />}
      <ConnectLink section="assistant">Steps for Claude and ChatGPT</ConnectLink>
    </div>
  );
}

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
    <Section id="devices" title="Devices">
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
      <Assistant />
      {link && (
        <div className="mt-3" data-enrolment>
          <p className="pb-2 text-lead text-muted-foreground">Open this on the other device before {when(link.expires_at)} to register a passkey there.</p>
          <Copyable text={link.url} label="enrolment link" block wrap />
        </div>
      )}
    </Section>
  );
}

