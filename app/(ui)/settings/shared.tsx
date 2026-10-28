// What the settings pages share: the section frame, the field style, and the one way they write (through
// /api/me/settings/*, so the phone does the same), reporting a refusal or a lost connection and never queueing.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { api, OfflineError } from '../client';
import { NOT_SENT } from '../components';

export type Urgency = 'log' | 'brief' | 'immediate';
export const URGENCIES: Urgency[] = ['log', 'brief', 'immediate'];

export const field = 'rounded-md border border-input bg-background px-2 py-1 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export const errorText = (e: unknown) => (e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed');

/** Writes through the settings API; a refusal or a lost connection is reported, never queued. */
export async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await api<T & { message?: string }>(path, { method, ...(body !== undefined ? { body } : {}) });
  if (r.status >= 400) throw new Error(r.body?.message ?? `the head answered ${r.status}`);
  return r.body;
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="pt-6" aria-labelledby={id} data-section-settings={id}>
      <h3 id={id} className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** Where a reader would have expected an explanation: one line to the reference page's section. */
export function ConnectLink({ section, children }: { section: string; children: ReactNode }) {
  return (
    <p className="pt-3 text-lead text-muted-foreground" data-connect-link>
      <Link href={`/connect#${section}`} className="underline decoration-border underline-offset-2 hover:text-foreground">{children}</Link>
    </p>
  );
}

/** An error from a write, above the page's content. */
export function PageError({ error }: { error: string | null }) {
  return error ? <p className="mt-2 text-lead text-destructive" role="alert">{error}</p> : null;
}
