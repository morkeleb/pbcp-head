import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// One pool per process. Next.js may evaluate this module more than once, so the pool hangs off globalThis.
const g = globalThis as unknown as { __pbcpDb?: ReturnType<typeof openDb> };

/** A Drizzle database over its own pool; the app uses `db()`, scripts and tests open their own. */
export function openDb(url: string, max = 10) {
  return drizzle(postgres(url, { max, onnotice: () => {} }));
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
