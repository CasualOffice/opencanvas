// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The database block's snapshot cache (DB4-07, DB100K): a change that only edits cells re-reads
// those rows and keeps every other row object, instead of reading all rows again. Anything else
// (fields, order, views, rows added or removed, notes) reads the whole database as before.

import * as Y from "yjs";
import { readDb } from "./model";
import type { CellValue, DbRow, DbSnapshot } from "./types";

export interface SnapCache {
  /** Bumped on every change; the snapshot is current when `at === ver`. */
  ver: number;
  at: number;
  snap: DbSnapshot | null;
  /** Something other than cell values changed since the last snapshot. */
  full: boolean;
  /** Rows whose cells changed since the last snapshot. */
  dirty: Set<string>;
  /** Row id → index in `snap.rows`. */
  index: Map<string, number> | null;
}

export const newSnapCache = (): SnapCache => ({ ver: 0, at: -1, snap: null, full: true, dirty: new Set(), index: null });

/** Records what a change touched: `rows.<id>` paths are cell edits, the rest needs a full read. */
export function noteChange(c: SnapCache, events?: readonly Y.YEvent<Y.AbstractType<unknown>>[]) {
  c.ver++;
  if (!events) {
    c.full = true;
    return;
  }
  for (const ev of events) {
    const p = ev.path;
    if (p.length >= 2 && p[0] === "rows") c.dirty.add(String(p[1]));
    else c.full = true;
  }
}

const sameVal = (a: CellValue | undefined, b: CellValue | undefined) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * Keep the previous snapshot's row and field objects when they did not change, so memoised
 * rows skip rendering: with 1,000 rows one edit re-renders one row, not the whole table.
 */
export function reuse(prev: DbSnapshot | null, next: DbSnapshot): DbSnapshot {
  if (!prev || prev.id !== next.id) return next;
  const old = new Map(prev.rows.map((r) => [r.id, r]));
  const rows = next.rows.map((r) => {
    const o = old.get(r.id);
    if (!o) return r;
    const ka = Object.keys(o.v),
      kb = Object.keys(r.v);
    return ka.length === kb.length && kb.every((k) => sameVal(o.v[k], r.v[k])) ? o : r;
  });
  const fields = JSON.stringify(prev.fields) === JSON.stringify(next.fields) ? prev.fields : next.fields;
  return { ...next, rows, fields };
}

/** The previous snapshot with only `dirty` rows re-read; null when it cannot be patched. */
export function patchRows(prev: DbSnapshot, m: Y.Map<unknown>, dirty: Iterable<string>, index: Map<string, number>): DbSnapshot | null {
  const rowsMap = m.get("rows");
  if (!(rowsMap instanceof Y.Map)) return null;
  let rows: DbRow[] | null = null;
  for (const rid of dirty) {
    const i = index.get(rid);
    const r = rowsMap.get(rid);
    if (i === undefined || !(r instanceof Y.Map)) return null;
    rows ??= prev.rows.slice();
    rows[i] = { id: rid, v: r.toJSON() as Record<string, CellValue> };
  }
  return rows ? { ...prev, rows } : prev;
}

/** The current snapshot, read incrementally when only cells changed. */
export function currentSnapshot(c: SnapCache, dbId: string, m: Y.Map<unknown> | null): DbSnapshot | null {
  if (c.at === c.ver) return c.snap;
  if (!m) {
    c.snap = null;
    c.index = null;
  } else {
    const patched = !c.full && c.snap && c.index ? patchRows(c.snap, m, c.dirty, c.index) : null;
    if (patched) c.snap = patched;
    else {
      c.snap = reuse(c.snap, readDb(dbId, m));
      c.index = new Map(c.snap.rows.map((r, i) => [r.id, i]));
    }
  }
  c.full = false;
  c.dirty.clear();
  c.at = c.ver;
  return c.snap;
}
