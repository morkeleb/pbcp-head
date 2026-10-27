// The one page in H1: sign in with a passkey, or register one from an enrolment link (`pnpm enroll <head>`).
// It calls the same /api/auth routes the phone will; the tokens it gets are kept in localStorage.

import { appleConfigured } from '../../lib/auth/apple';
import { SignIn } from './sign-in';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ enroll?: string }> }) {
  const { enroll } = await searchParams;
  return (
    <main className="legacy" style={{ maxWidth: 420, margin: '15vh auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 22 }}>Sign in</h1>
      <SignIn enroll={enroll ?? null} apple={appleConfigured()} />
    </main>
  );
}
