// pnpm rewrap --new-master <key> — rewraps every head's data key under a new master key (lib/at-rest.ts), one
// transaction per head. Run with the current HEAD_MASTER_KEY in the environment; set HEAD_MASTER_KEY to the new key
// once it reports done. No card is touched: the data keys themselves never change.
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { rewrap } from '../lib/at-rest';
import { masterKey } from '../lib/crypto';

const { values } = parseArgs({ options: { 'new-master': { type: 'string' } } });
const next = masterKey({ HEAD_MASTER_KEY: values['new-master'] });
if (!next) {
  console.error('usage: pnpm rewrap --new-master <32 bytes, base64>   (openssl rand -base64 32)');
  process.exit(2);
}
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set');
const n = await rewrap(openDb(url, 1), next, (l) => console.log(`rewrap: ${l}`));
console.log(`rewrap: ${n} heads rewrapped. Now set HEAD_MASTER_KEY to the new key, and keep a copy outside the host.`);
process.exit(0);
