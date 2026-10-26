// The head clock. Real time, except in test mode (PBCP_TEST_MODE=1), where the conformance adapter sets
// it through /api/test/clock so fixtures that care about timestamps can pin them (conformance README).

const g = globalThis as unknown as { __pbcpTestNow?: string };

export const testMode = (): boolean => process.env.PBCP_TEST_MODE === '1';

export function now(): string {
  if (testMode() && g.__pbcpTestNow !== undefined) return g.__pbcpTestNow;
  return new Date().toISOString();
}

export function setTestClock(iso: string | undefined): void {
  if (!testMode()) throw new Error('the test clock is only available in test mode');
  g.__pbcpTestNow = iso;
}

/** RFC 3339 UTC, without a fractional part when it is zero, so a clock set to `…:12Z` reads back as `…:12Z`. */
export function iso(d: Date): string {
  return d.toISOString().replace('.000Z', 'Z');
}
