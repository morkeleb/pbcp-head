// pnpm card:decrypt <id> [--head <owner>] — prints one card in clear for the operator, with HEAD_MASTER_KEY (step one).
// psql shows its content as ciphertext; this is the way to read it, and it reads nothing else.
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { decryptCard } from '../lib/at-rest';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { head: { type: 'string' } } });
const [id] = positionals;
if (!id) {
  console.error('usage: pnpm card:decrypt <id> [--head <owner>]');
  process.exit(2);
}
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set');
const c = await decryptCard(openDb(url, 1), id, values.head);
if (!c) {
  console.error(`no card ${id}`);
  process.exit(1);
}
console.log(JSON.stringify(c, null, 2));
process.exit(0);
