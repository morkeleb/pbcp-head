import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../db/migrate';
import { TEST_DATABASE_URL } from '../env';

const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
afterAll(() => client.end());

describe('migrations', () => {
  it('create every table, and applying them again is a no-op', async () => {
    await migrateDatabase(TEST_DATABASE_URL);
    await migrateDatabase(TEST_DATABASE_URL);
    const rows = await client<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(
      ['cards', 'change_counter', 'cron_runs', 'decision_log', 'devices', 'diagrams', 'heads', 'identities', 'label_ceilings', 'oauth_clients', 'oauth_codes', 'pairing_codes', 'producer_tokens', 'rate_limits'],
    );
  });
});
