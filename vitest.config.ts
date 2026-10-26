import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['test/*.test.ts', 'lib/**/*.test.ts'] },
      },
      {
        // Postgres-backed. test/db talks to pbcp_test directly; test/http and test/conformance go through a running
        // head (`next start`, test mode) on pbcp_test. They share one database, so files run one at a time.
        test: {
          name: 'integration',
          include: ['test/db/**/*.test.ts', 'test/http/**/*.test.ts', 'test/conformance/**/*.test.ts'],
          globalSetup: ['test/http/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
