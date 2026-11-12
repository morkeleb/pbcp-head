// Migration 0024 (docs/deploy.md "At rest", deploy 2): on a database at 0023, it refuses while any row holds content
// only in plaintext and changes nothing; once every row is sealed, it strips the producer documents to their clear
// fields, deletes the diagram rows the backfill marked as copied, drops the plaintext columns, and every card still
// opens whole from its sealed content.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client';
import { MIGRATIONS_DIR, migrateDatabase } from '../../db/migrate';
import { cards } from '../../db/schema';
import { dataKey } from '../../lib/keys';
import { CLEAR_FIELDS, openCardRow, sealDoc, sealField, sealLog } from '../../lib/vault';
import { TEST_DATABASE_URL } from '../env';

const SECRET = 'Kiwi-lawyer-7731';
const NAME = `pbcp_drop_${process.pid}`;
const url = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${NAME}`;
  return u.toString();
})();
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
let sql: postgres.Sql;
let before: string;

/** The migrations folder as it was before 0024. */
function folderAt0023(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pbcp-migrations-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  rmSync(join(dir, '0024_drop_plaintext.sql'));
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag !== '0024_drop_plaintext');
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  return dir;
}

beforeAll(async () => {
  await admin.unsafe(`drop database if exists ${NAME}`);
  await admin.unsafe(`create database ${NAME}`);
  sql = postgres(url, { max: 1, onnotice: () => {} });
  before = folderAt0023();
  await migrate(drizzle(sql), { migrationsFolder: before });
});
afterAll(async () => {
  await sql?.end();
  await admin.unsafe(`drop database if exists ${NAME}`);
  await admin.end();
  rmSync(before, { recursive: true, force: true });
});

const doc = { protocol: 'pbcp/1', id: 'mail:old:1', kind: 'decision', to_person: 'm', producer: 'mail', title: `Old ${SECRET}`, body: `Body ${SECRET}`, labels: ['old'], thread: 't-1', 'orders.claim_seq': 2, emitted_at: '2026-10-01T09:00:00Z' };
const columns = async (table: string) => (await sql<{ c: string }[]>`select column_name as c from information_schema.columns where table_name = ${table}`).map((r) => r.c);

describe('migration 0024: drop the plaintext columns', () => {
  it('keeps exactly the clear fields lib/vault.ts keeps, in both its lists', () => {
    const text = readFileSync(join(MIGRATIONS_DIR, '0024_drop_plaintext.sql'), 'utf8');
    const lists = [...text.matchAll(/IN \(('[^)]*')\)/g)].map((m) => new Set(m[1]!.split(',').map((x) => x.trim().replace(/'/g, ''))));
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l).toEqual(CLEAR_FIELDS);
  });

  it('refuses while a row is still plaintext, changes nothing, then strips and drops once every row is sealed', async () => {
    await sql`insert into heads (id) values ('m')`;
    await sql`insert into change_counter (head_id, seq) values ('m', 1)`;
    // A card as it was before encryption: nothing sealed.
    await sql`insert into cards (head_id, id, producer, namespace, producer_doc, delivery, state, change_seq, received_at, changed_at, day, decision, decided_at, comment, decided_doc, rendered_html)
      values ('m', 'mail:old:1', 'mail', 'old', ${JSON.stringify(doc)}::jsonb, 'brief', 'decided', 1, now(), now(), '2026-10-01', 'approve', now(), ${`Comment ${SECRET}`}, ${JSON.stringify(doc)}::jsonb, ${`<p>Body ${SECRET}</p>`})`;
    await sql`insert into decision_log (head_id, card_id, decision, comment, decided_at, decided_doc, actor) values ('m', 'mail:old:1', 'approve', ${`Comment ${SECRET}`}, now(), ${JSON.stringify(doc)}::jsonb, 'x')`;

    await expect(migrateDatabase(url)).rejects.toThrow(/plaintext/);
    expect(await columns('cards')).toContain('rendered_html');
    expect((await sql`select producer_doc from cards`)[0]!.producer_doc).toEqual(doc);

    // Sealed as deploy 1's backfill sealed it: content beside the plaintext columns, and an old diagram marked as copied.
    const db = openDb(url, 1);
    try {
      const key = (await dataKey(db, 'm', { create: true }))!;
      const s = sealDoc(key, 'm', 'mail:old:1', doc);
      const content = { v: 1, mac: s.mac, doc: s.doc, decided: sealField(key, 'm', 'mail:old:1', 'decided', doc), html: sealField(key, 'm', 'mail:old:1', 'html', `<p>Body ${SECRET}</p>`), comment: sealField(key, 'm', 'mail:old:1', 'comment', `Comment ${SECRET}`) };
      await sql`update cards set content = ${JSON.stringify(content)}::jsonb`;
      const seq = (await sql<{ seq: string }[]>`select seq from decision_log`)[0]!.seq;
      await sql`update decision_log set content = ${JSON.stringify(sealLog(key, 'm', Number(seq), { decidedDoc: doc, comment: `Comment ${SECRET}`, editedProposal: null }).content as never)}::jsonb`;
      await sql`insert into diagrams (hash, type, svg, content) values (${'a'.repeat(64)}, 'pie', ${`<svg>${SECRET}</svg>`}, ${JSON.stringify({ migrated: true })}::jsonb)`;
      await sql`insert into diagrams (hash, type, content) values (${'b'.repeat(64)}, 'pie', ${JSON.stringify({ public: true, svg: '<svg/>' })}::jsonb)`;

      await migrateDatabase(url);
      for (const c of ['comment', 'edited_proposal', 'rendered_html', 'rendered_actions', 'rendered_meta', 'rendered_paragraph']) expect(await columns('cards')).not.toContain(c);
      expect(await columns('decision_log')).not.toContain('comment');
      expect(await columns('diagrams')).not.toContain('svg');
      // The secret is nowhere in clear: producer_doc and both decided_docs hold the clear fields only.
      const n = async (t: string) => (await sql.unsafe(`select count(*)::int as n from ${t} t where t::text like '%${SECRET}%'`))[0]!.n;
      expect((await n('cards')) + (await n('decision_log')) + (await n('diagrams'))).toBe(0);
      const [row] = await db.select().from(cards);
      expect(row!.producerDoc).toEqual({ protocol: 'pbcp/1', id: 'mail:old:1', kind: 'decision', to_person: 'm', producer: 'mail', thread: 't-1', 'orders.claim_seq': 2, emitted_at: '2026-10-01T09:00:00Z' });
      expect((await sql`select hash from diagrams`).map((r) => r.hash)).toEqual(['b'.repeat(64)]);
      // And the card still opens whole.
      const open = openCardRow(row!, key);
      expect(open.producerDoc).toEqual(doc);
      expect(open.decidedDoc).toEqual(doc);
      expect(open).toMatchObject({ renderedHtml: `<p>Body ${SECRET}</p>`, comment: `Comment ${SECRET}` });
    } finally {
      await (db as unknown as { $client: postgres.Sql }).$client.end();
    }
  });
});
