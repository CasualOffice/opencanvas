// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The offline copy on the device (OFF-02, ADR-063, docs/34 §3.3). Per host and person: the
// device key, an encrypted index of the kept canvases (title, size, unsent changes, expiry) and
// the upload queue. Per canvas: the encrypted Yjs update log (y-indexeddb scheme: `updates`,
// compacted into one state now and then), the unsent queue (`pending`), and the grant and
// metadata (`custom`). Nothing of it ever goes to the server.
import * as Y from "yjs";
import { deviceKey, open, openJson, seal, sealJson, type GrantClaims, type Sealed } from "./crypto";
import type { Kv } from "./kv";
import { fileDb, hostDb, indexDb, keyDb, uploadsDb, userPrefix } from "./names";
import { FROM_DEVICE, type PendingEntry } from "./pending";
import type { PartHeader } from "../lib/parts";

/** Compact the update log into one state past this many entries. */
export const COMPACT_AT = 400;

export interface IndexEntry {
  file: string;
  title: string;
  /** The host's path for the list ("Engineering"), when known. */
  path?: string;
  bytes: number;
  pending: number;
  lastSent: number | null;
  exp: number;
  gen: number;
  role: GrantClaims["role"];
  keptAt: number;
  /** Kept by the host's `auto_recent`, not by the person. */
  auto?: boolean;
  /** View only on reconnect: unsent changes held for download or discard (frame 5a). */
  held?: boolean;
}

export interface CopyMeta extends IndexEntry {
  grant: string;
  jwk: JsonWebKey;
}

export interface Upload {
  id: string;
  file: string;
  name: string;
  mime: string;
  size: number;
  at: number;
}

export class Device {
  private keyP: Promise<CryptoKey | null> | null = null;
  constructor(
    readonly kv: Kv,
    readonly host: string,
    readonly user: string,
  ) {}

  /** Whether `db` was ever written (the host registry): reading never creates a database. */
  async has(db: string): Promise<boolean> {
    return !!(await this.kv.get(hostDb(this.host), "dbs", db).catch(() => undefined));
  }

  key(create = false): Promise<CryptoKey | null> {
    if (!this.keyP)
      this.keyP = (async () => {
        if (!create && !(await this.has(keyDb(this.host, this.user)))) return null;
        const k = await deviceKey(this.kv, this.host, this.user, create);
        if (k && create) await this.register(keyDb(this.host, this.user));
        return k;
      })();
    return this.keyP.then((k) => {
      if (!k && create) {
        this.keyP = null;
        return this.key(true);
      }
      return k;
    });
  }

  async register(db: string) {
    await this.kv.put(hostDb(this.host), "dbs", 1, db);
  }

  async list(): Promise<IndexEntry[]> {
    const k = await this.key();
    if (!k) return [];
    const rows = await this.kv.all<Sealed>(indexDb(this.host, this.user), "files");
    const out: IndexEntry[] = [];
    for (const [, s] of rows) {
      try {
        out.push(await openJson<IndexEntry>(k, s));
      } catch {
        /* sealed under an older key: unreadable, ignored */
      }
    }
    return out.sort((a, b) => b.keptAt - a.keptAt);
  }

  async usage(): Promise<{ bytes: number; count: number }> {
    const l = await this.list();
    return { bytes: l.reduce((n, e) => n + e.bytes, 0), count: l.length };
  }

  async putIndex(e: IndexEntry) {
    const k = await this.key(true);
    await this.kv.put(indexDb(this.host, this.user), "files", await sealJson(k!, e), e.file);
    await this.register(indexDb(this.host, this.user));
  }

  async dropIndex(file: string) {
    await this.kv.del(indexDb(this.host, this.user), "files", file);
  }

  copy(file: string) {
    return new Copy(this, file);
  }

  /** Deletes every copy of this person for this host: the key first (crypto-shred), then the
   *  databases. Returns how many canvases and unsent changes went. */
  async removeAll(): Promise<{ removed: number; pending: number; bytes: number }> {
    const list = await this.list().catch(() => []);
    await this.kv.drop(keyDb(this.host, this.user));
    this.keyP = null;
    const prefix = userPrefix(this.host, this.user);
    const known = new Set<string>([indexDb(this.host, this.user), uploadsDb(this.host, this.user), ...list.map((e) => fileDb(this.host, this.user, e.file))]);
    for (const n of (await this.kv.names()) ?? []) if (n.startsWith(prefix)) known.add(n);
    for (const [n] of await this.kv.all<number>(hostDb(this.host), "dbs")) if (String(n).startsWith(prefix)) known.add(String(n));
    for (const n of known) {
      await this.kv.drop(n);
      await this.kv.del(hostDb(this.host), "dbs", n);
    }
    return { removed: list.length, pending: list.reduce((n, e) => n + e.pending, 0), bytes: list.reduce((n, e) => n + e.bytes, 0) };
  }

  // ---------- queued uploads (OFF-05) ----------

  async queueUpload(u: Upload, data: Uint8Array) {
    const k = await this.key(true);
    await this.kv.put(uploadsDb(this.host, this.user), "files", { meta: await sealJson(k!, u), data: await seal(k!, data) }, u.id);
    await this.register(uploadsDb(this.host, this.user));
  }

  async uploads(file?: string): Promise<Upload[]> {
    const k = await this.key();
    if (!k) return [];
    const out: Upload[] = [];
    for (const [, v] of await this.kv.all<{ meta: Sealed }>(uploadsDb(this.host, this.user), "files")) {
      try {
        const u = await openJson<Upload>(k, v.meta);
        if (!file || u.file === file) out.push(u);
      } catch {
        /* unreadable */
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  async uploadData(id: string): Promise<Uint8Array | null> {
    const k = await this.key();
    const v = await this.kv.get<{ data: Sealed }>(uploadsDb(this.host, this.user), "files", id);
    return k && v ? open(k, v.data) : null;
  }

  async dropUpload(id: string) {
    await this.kv.del(uploadsDb(this.host, this.user), "files", id);
  }
}

export class Copy {
  readonly db: string;
  private count = 0;
  constructor(
    readonly device: Device,
    readonly file: string,
  ) {
    this.db = fileDb(device.host, device.user, file);
  }

  private get kv() {
    return this.device.kv;
  }

  async meta(): Promise<CopyMeta | null> {
    if (!(await this.device.has(this.db))) return null;
    const k = await this.device.key();
    const s = k && (await this.kv.get<Sealed>(this.db, "custom", "meta"));
    if (!k || !s) return null;
    try {
      return await openJson<CopyMeta>(k, s);
    } catch {
      return null;
    }
  }

  async setMeta(m: CopyMeta) {
    const k = await this.device.key(true);
    await this.kv.put(this.db, "custom", await sealJson(k!, m), "meta");
    const { grant: _g, jwk: _j, ...entry } = m;
    await this.device.putIndex(entry);
    await this.device.register(this.db);
  }

  /** Writes the whole document as the log's first entry (keeping a canvas, compaction). */
  async snapshot(doc: Y.Doc): Promise<number> {
    const k = await this.device.key(true);
    const state = Y.encodeStateAsUpdate(doc);
    await this.kv.clear(this.db, "updates");
    await this.kv.put(this.db, "updates", await seal(k!, state));
    this.count = 1;
    return state.length;
  }

  /** Appends one update; returns the bytes added. */
  async append(update: Uint8Array, doc?: Y.Doc): Promise<number> {
    const k = await this.device.key();
    if (!k) return 0;
    await this.kv.put(this.db, "updates", await seal(k, update));
    if (++this.count > COMPACT_AT && doc) return this.snapshot(doc).then((n) => n - update.length);
    return update.length;
  }

  /** Applies the stored document to `doc`; returns false when nothing (readable) is stored. */
  async loadInto(doc: Y.Doc): Promise<boolean> {
    const k = await this.device.key();
    if (!k) return false;
    const rows = await this.kv.all<Sealed>(this.db, "updates");
    if (!rows.length) return false;
    const updates: Uint8Array[] = [];
    for (const [, s] of rows) updates.push(await open(k, s));
    this.count = rows.length;
    Y.applyUpdate(doc, Y.mergeUpdates(updates), FROM_DEVICE);
    return true;
  }

  /** PSYNC-03: a split room's parts list (an offline copy holds every part, ADR-076). */
  async savePartList(list: PartHeader[]) {
    const k = await this.device.key(true);
    await this.kv.put(this.db, "custom", await sealJson(k!, list), "parts");
  }

  /** One part's whole state (replaces the last one). */
  async savePart(id: string, state: Uint8Array) {
    const k = await this.device.key(true);
    await this.kv.put(this.db, "custom", await seal(k!, state), `part:${id}`);
  }

  /** The parts kept on the device: the list and each part's state. */
  async loadParts(): Promise<{ list: PartHeader[]; states: Map<string, Uint8Array> } | null> {
    const k = await this.device.key();
    if (!k) return null;
    const sealed = await this.kv.get<Sealed>(this.db, "custom", "parts");
    if (!sealed) return null;
    const list = await openJson<PartHeader[]>(k, sealed);
    const states = new Map<string, Uint8Array>();
    for (const [key, v] of await this.kv.all<Sealed>(this.db, "custom")) {
      const name = String(key);
      if (name.startsWith("part:")) states.set(name.slice(5), await open(k, v));
    }
    return { list, states };
  }

  async addPending(e: PendingEntry) {
    const k = await this.device.key();
    if (k) await this.kv.put(this.db, "pending", { at: e.at, s: await seal(k, e.update) }, e.id);
  }

  async pending(): Promise<PendingEntry[]> {
    const k = await this.device.key();
    if (!k) return [];
    const out: PendingEntry[] = [];
    for (const [id, v] of await this.kv.all<{ at: number; s: Sealed }>(this.db, "pending")) out.push({ id: Number(id), at: v.at, update: await open(k, v.s) });
    return out;
  }

  async confirm(upTo: number) {
    await this.kv.delUpTo(this.db, "pending", upTo);
  }

  async clearPending() {
    await this.kv.clear(this.db, "pending");
  }

  async remove() {
    await this.kv.drop(this.db);
    await this.device.dropIndex(this.file);
    await this.kv.del(hostDb(this.device.host), "dbs", this.db);
    for (const u of await this.device.uploads(this.file)) await this.device.dropUpload(u.id);
  }
}
