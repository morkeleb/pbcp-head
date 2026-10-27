import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connectionUrl } from './url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/** Applies db/migrations to the database at `url`. */
export async function migrateDatabase(url: string): Promise<void> {
  const client = postgres(connectionUrl(url), { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end();
  }
}
