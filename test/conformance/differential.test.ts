// Differential run: every core fixture through @pbcp/core's in-process adapter and through this head over
// HTTP, recording each call. The fixtures match partially; this compares the whole response — status, every
// field of every card, sync pages and `next` — so any place the two implementations disagree shows up, not
// only the places a fixture happens to check. Both use a sync page cap of 2 so their pages line up.
// Error bodies are compared by code; messages are for people (§7.4).

import { loadFixtures, runFixture, type HeadUnderTest, type Response } from '@pbcp/core/conformance';
import { describe, expect, inject, it } from 'vitest';
import { inProcessHead } from '../../vendor/pbcp/packages/core/conformance/in-process/head';
import { testDb } from '../http/helpers';
import { httpHead } from './http-head';

interface Call {
  op: string;
  arg: unknown;
  status?: number;
  body?: unknown;
}

function recording(h: HeadUnderTest, log: Call[]): HeadUnderTest {
  const rec = (op: string, arg: unknown) => async (r: Promise<Response>) => {
    const res = await r;
    log.push({ op, arg, status: res.status, body: res.body });
    return res;
  };
  const cardId = (c: unknown) => (typeof c === 'string' ? `(file form) ${/^id:\s*(.*)$/m.exec(c)?.[1] ?? '?'}` : (c as { id?: unknown })?.id);
  return {
    reset: () => h.reset(),
    token: (root, o) => h.token(root, o),
    describe: (t) => rec('describe', null)(h.describe(t)),
    put: (t, c) => rec('put', cardId(c))(h.put(t, c)),
    changes: (t, after) => rec('changes', after)(h.changes(t, after)),
    decide: (id, d) => rec('decide', { id, ...d })(h.decide(id, d)),
    order: (input) => rec('order', input)(h.order!(input)),
    claim: (t, id, lease) => rec('claim', { id, lease })(h.claim!(t, id, lease)),
    decideWithToken: (t, id, d) => rec('decideWithToken', { id, ...d })(h.decideWithToken(t, id, d)),
    seen: (id) => rec('seen', id)(h.seen(id)),
    acknowledge: (id) => rec('acknowledge', id)(h.acknowledge(id)),
    clock: {
      set: (iso) => {
        log.push({ op: 'clock', arg: iso });
        h.clock.set(iso);
      },
    },
  };
}

/**
 * Order ids are minted by each head (`head:order:<ulid>`, A.1) and cannot match across heads; they are renamed
 * `head:order:#n` by order of first appearance in each run. Nothing else is normalised.
 */
function normaliseOrderIds(calls: Call[]): Call[] {
  const names = new Map<string, string>();
  const name = (s: string) => s.replace(/head:order:[0-9A-HJKMNP-TV-Z]{26}/g, (m) => {
    if (!names.has(m)) names.set(m, `head:order:#${names.size + 1}`);
    return names.get(m)!;
  });
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? name(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [name(k), walk(x)])) : v;
  return calls.map((c) => walk(c) as Call);
}

/**
 * `order` goes through /api/me/orders, which answers with the human API's card: the protocol card plus these
 * presentation members. The differential compares protocol representations, so exactly these are dropped.
 */
const PRESENTATION = ['rendered_html', 'rendered_actions', 'first_visual', 'order_outcome'];
function withoutPresentation(calls: Call[]): Call[] {
  return calls.map((c) =>
    c.op === 'order' && c.body && typeof c.body === 'object'
      ? { ...c, body: Object.fromEntries(Object.entries(c.body).filter(([k]) => !PRESENTATION.includes(k))) }
      : c,
  );
}

const isErrorBody = (b: unknown): b is { error: string } => typeof b === 'object' && b !== null && typeof (b as { error?: unknown }).error === 'string' && !('id' in b);

/** Paths at which `a` and `b` differ. */
function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (isErrorBody(a) && isErrorBody(b)) {
    if (a.error !== b.error) out.push(`${path}.error: in-process ${a.error}, http ${b.error}`);
    return;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    return;
  }
  if (a !== b) out.push(`${path}: in-process ${JSON.stringify(a)}, http ${JSON.stringify(b)}`);
}

/**
 * Disagreements found, reported to pbcp, and asserted here exactly, so they stay visible and anything new
 * fails. Remove an entry when pbcp fixes it (the test then fails until it is removed).
 *
 * - The in-process adapter at af785f1 implements the orders extension but describes `extensions: []`;
 *   this head implements orders and says so (§7.5). The in-process adapter's describe() is hard-coded.
 */
const KNOWN: Record<string, (d: string) => boolean> = {
  C25: (d) => d === '#1 describe null.body.extensions.0: in-process undefined, http "orders"',
  C31: (d) => /^#\d+ describe null\.body\.extensions\.0: in-process undefined, http "orders"$/.test(d),
};

describe('in-process adapter vs HTTP head, call by call', () => {
  for (const fixture of loadFixtures('core')) {
    it(fixture.name, async () => {
      const inProc: Call[] = [];
      const overHttp: Call[] = [];
      const outcome = async (head: HeadUnderTest) => runFixture(fixture, { head }).then(() => 'pass', (e: Error) => `fail: ${e.message.split('\n')[0]}`);
      const a = await outcome(recording(inProcessHead({ pageSize: 2 }), inProc));
      const b = await outcome(recording(httpHead({ baseUrl: inject('headUrl'), db: testDb(), pageSize: 2 }), overHttp));

      const [a1, b1] = [normaliseOrderIds(inProc), normaliseOrderIds(withoutPresentation(overHttp))];
      inProc.splice(0, inProc.length, ...a1);
      overHttp.splice(0, overHttp.length, ...b1);
      const disagreements: string[] = [];
      if (a !== b) disagreements.push(`outcome: in-process ${a}, http ${b}`);
      if (inProc.length !== overHttp.length) disagreements.push(`calls: in-process ${inProc.length}, http ${overHttp.length}`);
      inProc.forEach((call, i) => {
        const other = overHttp[i];
        if (!other) return;
        diff({ op: call.op, arg: call.arg, status: call.status, body: call.body }, { ...other }, `#${i + 1} ${call.op} ${JSON.stringify(call.arg)}`, disagreements);
      });
      const known = KNOWN[fixture.name.slice(0, 3)];
      if (known) {
        expect(disagreements.length, 'a known disagreement went away: update KNOWN').toBeGreaterThan(0);
        expect(disagreements.filter((d) => !known(d))).toEqual([]);
      } else {
        expect(disagreements).toEqual([]);
      }
    });
  }
});
