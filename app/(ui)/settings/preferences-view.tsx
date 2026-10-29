'use client';

// Settings → Preferences: this device's theme, and the head's timezone override.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageRow, setTheme, useThemeChoice, type ThemeChoice } from '../chrome';
import { api, useOnline } from '../client';
import { call, errorText, field, PageError, Section } from './shared';

interface HeadSettings { timezone: string; timezone_source: 'override' | 'device' | 'default'; timezone_override: string | null }

export function PreferencesView() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageRow title="Preferences" back={{ href: '/settings', label: 'Settings' }} />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-2 min-[900px]:px-6" data-settings-page="preferences">
        <PageError error={error} />
        <Preferences onError={(e) => setError(errorText(e))} />
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
        </tbody>
      </table>
    </Section>
  );
}

