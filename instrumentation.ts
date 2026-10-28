// Runs once when a server or a Vercel function instance boots, before any request is handled.
import { refuseTestModeInProduction, requirePublicOrigin } from './lib/boot';

export function register(): void {
  refuseTestModeInProduction();
  requirePublicOrigin();
}
