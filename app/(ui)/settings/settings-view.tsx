'use client';

// Settings, the index: three pages and one list, each a link with one line. What the owner reads rather than changes
// (this head's facts, how producers and assistants connect) is on /connect.

import Link from 'next/link';
import { PageRow } from '../chrome';
import { ConnectLink } from './shared';

export const SETTINGS_PAGES = [
  { href: '/settings/producers', title: 'Producers', line: 'Tokens, pairing codes and ceilings.' },
  { href: '/settings/devices', title: 'Devices', line: 'Where you’re signed in, notifications, and assistants.' },
  { href: '/settings/preferences', title: 'Preferences', line: 'Theme and timezone.' },
  { href: '/settings/invites', title: 'Invite requests', line: 'Who asked for an invite at the front door.' },
] as const;

export function SettingsView() {
  return (
    <>
      <PageRow title="Settings" />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-4 min-[900px]:px-6" data-settings>
        <ul className="divide-y border-y" data-settings-index>
          {SETTINGS_PAGES.map((p) => (
            <li key={p.href}>
              <Link href={p.href} className="flex items-center justify-between gap-4 py-3 hover:bg-muted/40" data-settings-link={p.href}>
                <span>
                  <span className="block font-serif text-title font-semibold tracking-editorial">{p.title}</span>
                  <span className="block text-lead text-muted-foreground">{p.line}</span>
                </span>
                <span aria-hidden className="text-muted-foreground">→</span>
              </Link>
            </li>
          ))}
        </ul>
        <ConnectLink section="head">This head’s URL, owner id, and how producers and assistants connect</ConnectLink>
      </main>
    </>
  );
}
