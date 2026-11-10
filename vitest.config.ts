import { defineConfig } from 'vitest/config';
// The master key the head under test and the tests share (the same value as test/env.ts TEST_HEAD_MASTER_KEY).
const TEST_HEAD_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

export default defineConfig({
  test: {
    projects: [
      {
        // At rest: tests that open sealed rows in this process use the head under test's master key.
        test: { name: 'unit', include: ['test/*.test.ts', 'lib/**/*.test.ts'], env: { HEAD_MASTER_KEY: TEST_HEAD_MASTER_KEY } },
      },
      {
        // Postgres-backed. test/db talks to pbcp_test directly; test/http and test/conformance go through a running
        // head (`next start`, test mode) on pbcp_test. They share one database, so files run one at a time.
        test: {
          name: 'integration',
          env: { HEAD_MASTER_KEY: TEST_HEAD_MASTER_KEY },
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
