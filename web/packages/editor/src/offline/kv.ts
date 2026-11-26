// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// A small key-value layer over IndexedDB for the offline copy (OFF-02), with an in-memory
// twin for unit tests. Every database has the same stores: `updates` and `pending`
// (auto-increment logs, the y-indexeddb scheme plus the unsent queue), `custom` (grant and
// metadata), `files` (the index and the upload queue), `k` (the device key) and `dbs` (the
// host registry). Empty stores cost nothing.
export const STORES = ["updates", "pending", "custom", "files", "k", "dbs"] as const;
export type StoreName = (typeof STORES)[number];
const AUTO = new Set<StoreName>(["updates", "pending"]);

export interface Kv {
  get<T>(db: string, store: StoreName, key: IDBValidKey): Promise<T | undefined>;
  /** Without `key` on an auto-increment store: appends and returns the new key. */
  put(db: string, store: StoreName, value: unknown, key?: IDBValidKey): Promise<IDBValidKey>;
  all<T>(db: string, store: StoreName): Promise<[IDBValidKey, T][]>;
  del(db: string, store: StoreName, key: IDBValidKey): Promise<void>;
  /** Deletes every key up to and including `upTo` (auto-increment logs). */
  delUpTo(db: string, store: StoreName, upTo: number): Promise<void>;
  clear(db: string, store: StoreName): Promise<void>;
  drop(db: string): Promise<void>;
  /** Every database name, or null when the browser can't list them. */
  names(): Promise<string[] | null>;
  close(): void;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, bad) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });

export function idbKv(): Kv {
  const open = new Map<string, Promise<IDBDatabase>>();
  const db = (name: string) => {
    let p = open.get(name);
    if (!p) {
      p = new Promise<IDBDatabase>((ok, bad) => {
        const r = indexedDB.open(name, 2);
        r.onupgradeneeded = () => {
          for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, AUTO.has(s) ? { autoIncrement: true } : undefined);
        };
        r.onsuccess = () => {
          const d = r.result;
          // Another tab or the clear page deletes the database: let it.
          d.onversionchange = () => {
            d.close();
            open.delete(name);
          };
          ok(d);
        };
        r.onerror = () => bad(r.error);
        r.onblocked = () => bad(new Error("blocked"));
      });
      open.set(name, p);
      p.catch(() => open.delete(name));
    }
    return p;
  };
  const tx = async (name: string, store: StoreName, mode: IDBTransactionMode) => (await db(name)).transaction(store, mode).objectStore(store);
  return {
    async get(name, store, key) {
      return req((await tx(name, store, "readonly")).get(key));
    },
    async put(name, store, value, key) {
      return req((await tx(name, store, "readwrite")).put(value, key));
    },
    async all(name, store) {
      const s = await tx(name, store, "readonly");
      const [keys, values] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return keys.map((k, i) => [k, values[i]] as [IDBValidKey, never]);
    },
    async del(name, store, key) {
      await req((await tx(name, store, "readwrite")).delete(key));
    },
    async delUpTo(name, store, upTo) {
      await req((await tx(name, store, "readwrite")).delete(IDBKeyRange.upperBound(upTo)));
    },
    async clear(name, store) {
      await req((await tx(name, store, "readwrite")).clear());
    },
    async drop(name) {
      const p = open.get(name);
      open.delete(name);
      if (p) await p.then((d) => d.close(), () => undefined);
      await new Promise<void>((ok) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = () => ok();
      });
    },
    async names() {
      if (!indexedDB.databases) return null;
      try {
        return (await indexedDB.databases()).map((d) => d.name ?? "");
      } catch {
        return null;
      }
    },
    close() {
      for (const p of open.values()) void p.then((d) => d.close(), () => undefined);
      open.clear();
    },
  };
}

/** The same contract in memory (unit tests). */
export function memKv(): Kv & { dbs: Map<string, Map<StoreName, Map<IDBValidKey, unknown>>> } {
  const dbs = new Map<string, Map<StoreName, Map<IDBValidKey, unknown>>>();
  const counters = new Map<string, number>();
  const s = (db: string, store: StoreName) => {
    let d = dbs.get(db);
    if (!d) dbs.set(db, (d = new Map(STORES.map((n) => [n, new Map()]))));
    return d.get(store)!;
  };
  return {
    dbs,
    async get(db, store, key) {
      return s(db, store).get(key) as never;
    },
    async put(db, store, value, key) {
      let k = key;
      if (k === undefined) {
        const c = (counters.get(db + store) ?? 0) + 1;
        counters.set(db + store, c);
        k = c;
      }
      s(db, store).set(k, value);
      return k;
    },
    async all(db, store) {
      return [...s(db, store).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) as never;
    },
    async del(db, store, key) {
      s(db, store).delete(key);
    },
    async delUpTo(db, store, upTo) {
      const m = s(db, store);
      for (const k of [...m.keys()]) if (typeof k === "number" && k <= upTo) m.delete(k);
    },
    async clear(db, store) {
      s(db, store).clear();
    },
    async drop(db) {
      dbs.delete(db);
    },
    async names() {
      return [...dbs.keys()];
    },
    close() {},
  };
}
