// pnpm db:migrate — applies db/migrations.
//
// Migrations take a direct connection: DATABASE_URL_UNPOOLED when it is set (Neon's integration sets it
// beside the pooled DATABASE_URL the app uses), otherwise DATABASE_URL (local Postgres, Docker).
import { migrateDatabase } from '../db/migrate';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set');
await migrateDatabase(url);
console.log(`migrated (${process.env.DATABASE_URL_UNPOOLED ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL'})`);
