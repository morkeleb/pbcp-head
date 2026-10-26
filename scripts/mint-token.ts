// pnpm mint-token <head> <root> [--ceiling log|brief|immediate] [--executor] [--instance <name>]
//
// Creates the head (and its change counter) if it does not exist, then issues a producer token bound to
// one namespace root (RFC §12). The token is printed once; only its sha256 is stored.

import { URGENCIES, type Urgency } from '@pbcp/core';
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { mintProducerToken } from '../lib/auth/producer';
import { ensureHead } from '../lib/heads';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    ceiling: { type: 'string', default: 'brief' },
    executor: { type: 'boolean', default: false },
    instance: { type: 'string' },
  },
});

const [headId, root] = positionals;
if (!headId || !root || !(URGENCIES as readonly string[]).includes(values.ceiling)) {
  console.error('usage: pnpm mint-token <head> <root> [--ceiling log|brief|immediate] [--executor] [--instance <name>]');
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = openDb(url, 1);
await ensureHead(db, headId);
const token = await mintProducerToken(db, {
  headId,
  root,
  ceiling: values.ceiling as Urgency,
  executor: values.executor,
  ...(values.instance ? { instance: values.instance } : {}),
});
console.log(token);
await db.$client.end();
