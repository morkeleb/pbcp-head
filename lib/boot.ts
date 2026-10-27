// Checks made when the head starts: at build (next.config.ts) and when a server or function boots
// (instrumentation.ts). Test mode opens /api/test, which sets the head clock; it must never run in production.

export function refuseTestModeInProduction(env: Record<string, string | undefined> = process.env): void {
  if (env.PBCP_TEST_MODE && env.VERCEL_ENV === 'production') {
    throw new Error('PBCP_TEST_MODE is set on a production deployment (VERCEL_ENV=production); refusing to start. Remove it from the project’s environment variables.');
  }
}
