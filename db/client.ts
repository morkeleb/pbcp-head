import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { connectionUrl } from './url';

// One pool per process. Next.js may evaluate this module more than once, so the pool hangs off globalThis.
const g = globalThis as unknown as { __pbcpDb?: ReturnType<typeof openDb> };

/**
 * A Drizzle database over its own pool; the app uses `db()`, scripts and tests open their own.
 *
 * `prepare: false` so the same code runs through a transaction-mode pooler (Neon's pooled DATABASE_URL,
 * PgBouncer), which cannot keep a named statement on one server connection. Idle connections close after
 * 20 s, so a serverless instance that has gone quiet does not hold them.
 */
export function openDb(url: string, max = 10) {
  return drizzle(postgres(connectionUrl(url), { max, prepare: false, idle_timeout: 20, onnotice: () => {} }));
}

export function db() {
  if (!g.__pbcpDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    g.__pbcpDb = openDb(url);
  }
  return g.__pbcpDb;
}

export type Db = ReturnType<typeof db>;
