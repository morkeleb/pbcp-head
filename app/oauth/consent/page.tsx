// The consent step of OAuth for assistants (lib/oauth.ts): which app asks, what it may do, Allow or Deny. Signed in
// with a passkey first (/signin brings the owner back here). The masthead's name and the tokens; nothing else.

import type { Metadata } from 'next';
import { NAME } from '../../../lib/masthead';
import { Consent } from './consent';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Allow an app' };

export default function ConsentPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 pb-[10vh]">
      <h1 className="font-serif text-masthead font-semibold tracking-editorial">{NAME}</h1>
      <Consent />
    </main>
  );
}
