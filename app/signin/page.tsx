// Sign in with a passkey, or register one from an enrolment link (`pnpm enroll <head>`); there is no other way in.
// The masthead's name and the brief's tokens, the form centred, nothing else. It calls the same /api/auth routes the
// phone will; the tokens it gets are kept in localStorage.

import type { Metadata } from 'next';
import { appleConfigured } from '../../lib/auth/apple';
import { NAME } from '../../lib/masthead';
import { SignIn } from './sign-in';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ enroll?: string }> }) {
  const { enroll } = await searchParams;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 pb-[10vh]">
      <h1 className="font-serif text-masthead font-semibold tracking-editorial">{NAME}</h1>
      <SignIn enroll={enroll ?? null} apple={appleConfigured()} />
    </main>
  );
}
