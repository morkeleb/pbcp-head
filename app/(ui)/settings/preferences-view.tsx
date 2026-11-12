'use client';

// Settings → Preferences: this device's theme, the head's timezone override, and the owner's sensitivity floor for every
// card (RFC 0.9 §9).

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageRow, setTheme, useThemeChoice, type ThemeChoice } from '../chrome';
import { api, useOnline } from '../client';
import { call, errorText, field, FloorSelect, PageError, Section, type Sensitivity } from './shared';
import { downloadArchive, dropArchive, RETENTION_DEFAULT, setRetention } from '../local/feed';
import { getMeta, storeSize } from '../local/store';

interface HeadSettings { timezone: string; timezone_source: 'override' | 'device' | 'default'; timezone_override: string | null; sensitivity_floor: Sensitivity | null }

export function PreferencesView() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageRow title="Preferences" back={{ href: '/settings', label: 'Settings' }} />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-2 min-[900px]:px-6" data-settings-page="preferences">
        <PageError error={error} />
        <Preferences onError={(e) => setError(errorText(e))} />
        <OnThisDevice />
      </main>
    </>
  );
}

function Preferences({ onError }: { onError: (e: unknown) => void }) {
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
    <Section id="preferences" title="Preferences">
      <table className="w-full text-body" data-preferences>
        <tbody className="divide-y border-y">
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
          {row(
            'Sensitivity',
            <FloorSelect label="Sensitivity floor for every card" value={head?.sensitivity_floor ?? null} disabled={!online || !head} none="as each producer sends"
              onChange={(v) => void call('/api/me/settings', 'PATCH', { sensitivity_floor: v }).catch(onError).then(load)} />,
            'Private: a card’s lead and body stay off notifications and assistants. Confirm: also, deciding asks for your passkey. Raises every card, already here or not; never lowers what a producer asked for.',
          )}
        </tbody>
      </table>
    </Section>
  );
}


const RETENTIONS = [30, 90, 180, 365];
const mb = (bytes: number) => (bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} kB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

/**
 * The device's copy of the brief (docs/local-first.md): how many days it keeps, how much room it takes, and the archive.
 * The head keeps everything regardless; the device chooses how much of it to hold.
 */
function OnThisDevice() {
  const online = useOnline();
  const [retention, setDays] = useState<number | null>(null);
  const [archive, setArchive] = useState(false);
  const [size, setSize] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [none, setNone] = useState(false);
  const read = useCallback(async () => {
    const cursor = await getMeta('cursor');
    setNone(cursor === null);
    setDays((await getMeta('retention')) ?? RETENTION_DEFAULT);
    setArchive((await getMeta('archive')) === true);
    setSize(await storeSize());
  }, []);
  useEffect(() => void read(), [read]);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
      await read();
    }
  };
  return (
    <Section id="device" title="On this device">
      <p className="pb-2 text-lead text-muted-foreground">
        The brief reads from this device first, works offline, and sends what you do when the network returns. Search runs here; the head holds no index of your cards.
        {' '}On iPhone, the copy is kept for the app installed to the Home Screen; Safari may clear a website’s storage after a week unused, and then it is pulled again.
      </p>
      {none ? (
        <p className="text-lead text-muted-foreground" data-device-none>This device has no copy yet, or its browser keeps none (a private window). The brief reads from the head.</p>
      ) : (
        <table className="w-full text-body" data-device>
          <tbody className="divide-y border-y">
            <tr>
              <th scope="row" className="w-28 py-2 pr-3 text-left align-top font-normal text-muted-foreground">Keep</th>
              <td className="py-2">
                <select aria-label="Days kept on this device" className={field} value={retention ?? RETENTION_DEFAULT} disabled={!online || archive || !!busy}
                  onChange={(e) => void run('retention', () => setRetention(Number(e.target.value)))}>
                  {RETENTIONS.map((d) => <option key={d} value={d}>the last {d} days</option>)}
                </select>
                {archive && <p className="pt-1 text-lead text-muted-foreground">Everything, back to the first card: the archive is on this device.</p>}
              </td>
            </tr>
            <tr>
              <th scope="row" className="w-28 py-2 pr-3 text-left align-top font-normal text-muted-foreground">Archive</th>
              <td className="py-2">
                {archive ? (
                  <Button size="xs" variant="outline" disabled={!!busy} onClick={() => void run('drop', dropArchive)}>Keep only the last {retention} days</Button>
                ) : (
                  <Button size="xs" variant="outline" disabled={!online || !!busy} onClick={() => void run('archive', () => downloadArchive())} data-download-archive>
                    {busy === 'archive' ? 'Downloading…' : 'Download the archive'}
                  </Button>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" className="w-28 py-2 pr-3 text-left align-top font-normal text-muted-foreground">Size</th>
              <td className="py-2" data-device-size>
                {size ? `${mb(size.usage)} in use${size.persisted ? ', kept by the browser' : ''}` : 'The browser does not say.'}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </Section>
  );
}
