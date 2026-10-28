// pnpm mint-token <head> <root> [--ceiling log|brief|immediate] [--executor] [--instance <name>]
//
// Creates the head (and its change counter) if it does not exist, then issues a producer token bound to
// one namespace root (RFC §12), the same way the settings page does (lib/settings/producers.ts): the root is
// validated and must not already have a live token for that instance. The token is printed once; only its
// sha256 is stored.

import { URGENCIES, type Urgency } from '@pbcp/core';
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { ensureHead } from '../lib/heads';
import { mintToken } from '../lib/settings/producers';

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
try {
  await ensureHead(db, headId);
  const { token } = await mintToken(db, headId, {
    root,
    ceiling: values.ceiling as Urgency,
    executor: values.executor,
    ...(values.instance ? { instance: values.instance } : {}),
  });
  console.log(token);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
