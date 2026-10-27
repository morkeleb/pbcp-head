// Connection strings from hosted Postgres, as postgres.js should see them (db/url.ts).
import { describe, expect, it } from 'vitest';
import { connectionUrl } from '../db/url';

describe('connectionUrl', () => {
  it('drops channel_binding and verifies Neon’s certificate', () => {
    const neon = 'postgresql://u:p@ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
    const out = new URL(connectionUrl(neon));
    expect(out.searchParams.get('channel_binding')).toBeNull();
    expect(out.searchParams.get('sslmode')).toBe('verify-full');
    expect(out.hostname).toBe('ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech');
    expect(out.password).toBe('p');
  });

  it('keeps other URLs as written', () => {
    expect(connectionUrl('postgres://pbcp:pbcp@localhost:5433/pbcp')).toBe('postgres://pbcp:pbcp@localhost:5433/pbcp');
    expect(new URL(connectionUrl('postgres://u@db.example.com/x?sslmode=require')).searchParams.get('sslmode')).toBe('require');
  });
});
