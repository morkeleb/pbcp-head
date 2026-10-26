import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// One pool per process. Next.js may evaluate this module more than once in dev, so the pool hangs off globalThis.
const g = globalThis as unknown as { __pbcpSql?: postgres.Sql };

export function sql(): postgres.Sql {
  if (!g.__pbcpSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    g.__pbcpSql = postgres(url, { max: 10, onnotice: () => {} });
  }
  return g.__pbcpSql;
}

export const db = () => drizzle(sql());
export type Db = ReturnType<typeof db>;
