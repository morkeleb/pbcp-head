// Runs once when a server or a Vercel function instance boots, before any request is handled.
import { refuseTestModeInProduction, requirePublicOrigin } from './lib/boot';

export async function register(): Promise<void> {
  refuseTestModeInProduction();
  requirePublicOrigin();
  // At rest (docs/deploy.md): a head that holds encrypted content and has no HEAD_MASTER_KEY (or a malformed one) does
  // not start, rather than serve a head it cannot read. Node only: the edge runtime has no database client here.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.DATABASE_URL) {
    const { db } = await import('./db/client');
    const { requireMasterKeyIfNeeded } = await import('./lib/keys');
    await requireMasterKeyIfNeeded(db());
  }
}
