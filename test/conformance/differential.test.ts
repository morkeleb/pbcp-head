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

describe('in-process adapter vs HTTP head, call by call', () => {
  for (const fixture of loadFixtures('core')) {
    it(fixture.name, async () => {
      const inProc: Call[] = [];
      const overHttp: Call[] = [];
      const outcome = async (head: HeadUnderTest) => runFixture(fixture, { head }).then(() => 'pass', (e: Error) => `fail: ${e.message.split('\n')[0]}`);
      const a = await outcome(recording(inProcessHead({ pageSize: 2 }), inProc));
      const b = await outcome(recording(httpHead({ baseUrl: inject('headUrl'), db: testDb(), pageSize: 2 }), overHttp));

      const disagreements: string[] = [];
      if (a !== b) disagreements.push(`outcome: in-process ${a}, http ${b}`);
      if (inProc.length !== overHttp.length) disagreements.push(`calls: in-process ${inProc.length}, http ${overHttp.length}`);
      inProc.forEach((call, i) => {
        const other = overHttp[i];
        if (!other) return;
        diff({ op: call.op, arg: call.arg, status: call.status, body: call.body }, { ...other }, `#${i + 1} ${call.op} ${JSON.stringify(call.arg)}`, disagreements);
      });
      expect(disagreements).toEqual([]);
    });
  }
});
