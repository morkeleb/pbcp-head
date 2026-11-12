// One request's keys (lib/keys.ts): a keyring unwraps each head's data key once, the first time the request needs it,
// and every open in that request shares it. It is made at the top of a route handler or an operation and dropped with
// it: never a module-level cache, nothing that outlives the request. Step two will hand the session's key material in
// here instead of the master key's unwrap. Inside a transaction the keyring takes the transaction.

import type { Db } from '../db/client';
import { dataKey } from './keys';
import type { Tx } from './store';

export interface Keyring<D extends Db | Tx = Db | Tx> {
  /** The head's data key, unwrapped once for this keyring; `create` makes one on the head's first write. */
  (headId: string, opts?: { create?: boolean }): Promise<Buffer | null>;
  /** The database (or transaction) the keyring reads keys from, and its caller reads rows from. */
  readonly db: D;
}

export function keyring<D extends Db | Tx>(db: D): Keyring<D> {
  const keys = new Map<string, Promise<Buffer | null>>();
  const ring = async (headId: string, opts: { create?: boolean } = {}) => {
    const hit = keys.get(headId);
    if (hit) {
      const key = await hit;
      if (key || !opts.create) return key;
    }
    const k = dataKey(db, headId, opts);
    keys.set(headId, k);
    return k;
  };
  return Object.assign(ring, { db });
}

/** A keyring passed in, or one made for this call from a database (a caller not yet threading one through). */
export function asKeyring<D extends Db | Tx>(src: D | Keyring<D>): Keyring<D> {
  return typeof src === 'function' ? (src as Keyring<D>) : keyring(src as D);
}
