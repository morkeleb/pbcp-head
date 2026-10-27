// Runs once when a server or a Vercel function instance boots, before any request is handled.
import { refuseTestModeInProduction } from './lib/boot';

export function register(): void {
  refuseTestModeInProduction();
}
