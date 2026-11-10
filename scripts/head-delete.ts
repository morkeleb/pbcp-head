// pnpm head:delete <owner> — deletes a head: its data key first, so every sealed value of it is unreadable from that
// moment (crypto-shredding), then its rows (lib/at-rest.ts). Cannot be undone.
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { deleteHead } from '../lib/at-rest';

const { positionals } = parseArgs({ allowPositionals: true });
const [owner] = positionals;
if (!owner) {
  console.error('usage: pnpm head:delete <owner>');
  process.exit(2);
}
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set');
await deleteHead(openDb(url, 1), owner);
console.log(`head:delete: ${owner}'s key is destroyed and its rows deleted`);
process.exit(0);
