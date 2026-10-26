// Head settings that the test hooks (/api/test, PBCP_TEST_MODE=1 only) may override.

import { testMode } from './clock';

/** §7.2 permits a page cap; this head returns at most 200 changes per sync page. */
export const SYNC_PAGE_SIZE = 200;

const g = globalThis as unknown as { __pbcpSyncPageSize?: number };

/** The sync page cap: 200, or a smaller cap a test asked for so paging is exercised with few cards. */
export function syncPageSize(): number {
  return testMode() && g.__pbcpSyncPageSize !== undefined ? g.__pbcpSyncPageSize : SYNC_PAGE_SIZE;
}

export function setSyncPageSize(n: number | undefined): void {
  if (!testMode()) throw new Error('only available in test mode');
  g.__pbcpSyncPageSize = n;
}
