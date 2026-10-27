import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { openDb } from '../../db/client';
import { startSession } from '../../lib/auth/session';
import { ensureHead } from '../../lib/heads';
import { TEST_DATABASE_URL, TEST_SESSION_SECRET } from '../env';

// Sessions are signed here with the secret the head under test was started with.
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

export const OWNER = 'morten';

const g = globalThis as unknown as { __testDb?: ReturnType<typeof openDb> };

/** The database the head under test uses, for arranging state and reading it back. */
export function testDb() {
  g.__testDb ??= openDb(TEST_DATABASE_URL, 2);
  return g.__testDb;
}

export const headUrl = (): string => inject('headUrl');

/** An empty head owned by `owner`: every table truncated, the head and its counter recreated. */
export async function resetHead(owner = OWNER): Promise<void> {
  // The previous test's cards may still be rendering after their responses (lib/render renderAfterCommit, now two
  // drawings per fence): a truncate that deadlocks with that work is retried.
  for (let attempt = 1; ; attempt++) {
    try {
      await testDb().execute(
        sql`truncate decision_log, devices, identities, cards, producer_tokens, change_counter, heads, diagrams, rate_limits restart identity`,
      );
      break;
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
      if (code !== '40P01' || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  await ensureHead(testDb(), owner);
}

export async function call(method: string, path: string, opts: { auth?: string; body?: unknown; type?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth) headers.authorization = opts.auth;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] = opts.type ?? (typeof opts.body === 'string' ? 'text/markdown' : 'application/json');
  }
  const res = await fetch(`${headUrl()}${path}`, { method, headers, body, redirect: 'follow' });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: res.status, body: parsed as any, headers: res.headers };
}

/** A signed-in device for the owner, as a sign-in would create, without the passkey ceremony. */
export async function ownerSession(owner = OWNER, name = 'test device'): Promise<{ auth: string; deviceId: string }> {
  const t = await startSession(testDb(), { headId: owner, identityId: null, platform: 'web', name });
  return { auth: `Session ${t.access_token}`, deviceId: t.device_id };
}
