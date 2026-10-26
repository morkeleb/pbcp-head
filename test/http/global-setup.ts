// Starts the built head (`next start`) in test mode against pbcp_test, unless HEAD_URL names one already running.
// Run `pnpm build` first; `pnpm test` does.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
import { migrateDatabase } from '../../db/migrate';
import { TEST_APPLE_CLIENT_ID, TEST_APPLE_PORT, TEST_CRON_SECRET, TEST_DATABASE_URL, TEST_HEAD_PORT, TEST_SESSION_SECRET } from '../env';

declare module 'vitest' {
  export interface ProvidedContext {
    headUrl: string;
  }
}

let server: ChildProcess | undefined;

export async function setup(project: TestProject): Promise<void> {
  await migrateDatabase(TEST_DATABASE_URL);
  let url = process.env.HEAD_URL;
  if (!url) {
    if (!existsSync('.next/BUILD_ID')) throw new Error('no build in .next: run `pnpm build` (or `pnpm test`, which does)');
    url = `http://localhost:${TEST_HEAD_PORT}`;
    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(TEST_HEAD_PORT)], {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        PBCP_TEST_MODE: '1',
        SESSION_SECRET: TEST_SESSION_SECRET,
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_ORIGIN: url,
        PBCP_HEAD: '',
        CRON_SECRET: TEST_CRON_SECRET,
        APPLE_CLIENT_ID: TEST_APPLE_CLIENT_ID,
        APPLE_JWKS_URL: `http://localhost:${TEST_APPLE_PORT}/auth/keys`,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
    await waitFor(`${url}/api/test/clock`);
  }
  project.provide('headUrl', url);
}

export async function teardown(): Promise<void> {
  if (server?.pid) process.kill(-server.pid, 'SIGTERM');
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the head did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
