'use client';

// The device's database (docs/local-first.md): one IndexedDB database per owner, holding the projection (cards as
// /api/me returns them, by id, with a day index), the meta rows (the change cursor, settings, the last brief the head
// composed) and the command outbox. Every access goes through `withStore`, which never throws: a private window, a
// store Safari evicted, a quota error or a blocked upgrade all come back as `null`, and the app runs from the network
// alone, as it did before there was a store. The first sync simply runs again next time.

const VERSION = 1;
export const CARDS = 'cards';
export const META = 'meta';
export const OUTBOX = 'outbox';

let opening: { owner: string; db: Promise<IDBDatabase | null> } | null = null;

/** The browser's IndexedDB, or null: in some private windows even reading the global throws. */
function idb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}
let broken = false;

/** Whether the store failed this session (the app is network-only until the page loads again). */
export const storeBroken = () => broken;

function open(owner: string): Promise<IDBDatabase | null> {
  const factory = idb();
  if (broken || !factory) {
    broken = true;
    return Promise.resolve(null);
  }
  if (opening?.owner === owner) return opening.db;
  const db = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(`pbcp-${owner}`, VERSION);
    } catch {
      broken = true;
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(CARDS)) {
        const cards = d.createObjectStore(CARDS, { keyPath: 'id' });
        cards.createIndex('day', 'day');
        cards.createIndex('change_seq', 'change_seq');
      }
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
      if (!d.objectStoreNames.contains(OUTBOX)) d.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => {
      const d = req.result;
      // Another tab upgrading, or the database deleted (sign-out): let go, and open again next time.
      d.onversionchange = () => {
        d.close();
        opening = null;
      };
      resolve(d);
    };
    req.onerror = () => {
      broken = true;
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
  opening = { owner, db };
  return db;
}

/** A request as a promise. */
export const done = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/**
 * Runs `fn` in one transaction over `stores` of the owner's database, resolving with its result once the transaction
 * commits; `null` when there is no store or anything throws (the store is then marked broken for the session).
 */
export async function withStore<T>(owner: string, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T | null> {
  const db = await open(owner);
  if (!db) return null;
  try {
    const t = db.transaction(stores, mode);
    const committed = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('aborted'));
    });
    const result = await fn(t);
    await committed;
    return result;
  } catch {
    broken = true;
    opening = null;
    return null;
  }
}

/** Deletes the owner's database (sign-out, or a store that must be rebuilt). */
export async function dropStore(owner: string): Promise<void> {
  try {
    const d = await opening?.db;
    d?.close();
  } catch {
    // nothing open
  }
  opening = null;
  const factory = idb();
  if (!factory) return;
  await new Promise<void>((resolve) => {
    try {
      const r = factory.deleteDatabase(`pbcp-${owner}`);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
