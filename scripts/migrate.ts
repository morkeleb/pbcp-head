// pnpm db:migrate — applies db/migrations to $DATABASE_URL.
import { migrateDatabase } from '../db/migrate';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
await migrateDatabase(url);
console.log('migrated');
