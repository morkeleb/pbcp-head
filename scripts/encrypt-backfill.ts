// pnpm encrypt-backfill [--verify] — seals what is still in clear (docs/deploy.md "At rest"). Since migration 0024
// dropped the plaintext columns, that is only invite addresses recorded before the deployment had a head; the cards,
// decision log and diagrams were sealed by deploy 1.
//
// Idempotent, and exits at once when nothing is left, so production builds run it right after `pnpm db:migrate` at no
// cost. `--verify` changes nothing and exits 1 while any row is outside its sealed form.
import { parseArgs } from 'node:util';
import { openDb } from '../db/client';
import { backfill, remaining } from '../lib/at-rest';
import { requireMasterKeyIfNeeded } from '../lib/keys';

const { values } = parseArgs({ options: { verify: { type: 'boolean', default: false } } });
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set');
const db = openDb(url, 1);
const line = (r: { cards: number; decision_log: number; diagrams: number; invite_requests: number }) =>
  `${r.cards} cards, ${r.decision_log} decision-log rows, ${r.diagrams} diagrams, ${r.invite_requests} invite requests`;

if (values.verify) {
  const r = await remaining(db);
  const n = r.cards + r.decision_log + r.diagrams + r.invite_requests;
  console.log(n === 0 ? 'encrypt-backfill --verify: 0 rows still plaintext' : `encrypt-backfill --verify: ${n} rows still plaintext (${line(r)})`);
  process.exit(n === 0 ? 0 : 1);
}
await requireMasterKeyIfNeeded(db);
if (!process.env.HEAD_MASTER_KEY) {
  // No key, and nothing sealed yet: a head that has never been encrypted. Sealing needs the key: say so, fail the build.
  const r = await remaining(db);
  if (r.cards + r.decision_log + r.diagrams + r.invite_requests > 0) throw new Error('HEAD_MASTER_KEY is not set: set it (openssl rand -base64 32) and keep a copy outside the host before deploying (docs/deploy.md "At rest")');
  console.log('encrypt-backfill: nothing to seal');
  process.exit(0);
}
const left = await backfill(db, (l) => console.log(`encrypt-backfill: ${l}`));
console.log(`encrypt-backfill: done; ${line(left)} left`);
process.exit(0);
