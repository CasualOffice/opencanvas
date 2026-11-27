// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frame 8a): "Open as spreadsheet" on a database, approved with both options.
//
// Convert: a new Spreadsheet block holding the values; the database doesn't change.
// View: a Spreadsheet block linked to the database (`sheets[block].link`). Its first sheet's
// rows are the database's records (row id = record id, after a header row) and its first
// columns are the fields (column id = field id); free columns follow on the right for the
// reader's own formulas. The editor keeps the two in step (editor/chart/SheetLink.tsx): a
// record or field change is written into the cells, and an edit in a field column is written
// back to the record. Formulas belong in the free columns; in a field column they are refused.

import * as Y from "yjs";
import { blockMap, newId, sheetsRoot } from "./model";

export const HEADER_ROW = "hdr";
/** Free rows and columns a new block has past its data. */
const PAD_ROWS = 20;
const PAD_COLS = 4;
export const LINK_ORIGIN = { source: "@opencanvas/sheet/link" };

/** A database as the view needs it: fields (non-computed) and each record's cells as text. */
export interface LinkedDb {
  fields: { id: string; name: string; type: string }[];
  rows: { id: string; cells: string[] }[];
}

const SAFE = /^[A-Za-z0-9_-]+$/;

function firstSheet(doc: Y.Doc, block: string): Y.Map<unknown> | null {
  const b = blockMap(doc, block);
  const id = (b?.get("order") as Y.Array<string> | undefined)?.get(0);
  return id ? (((b!.get("sheets") as Y.Map<Y.Map<unknown>>).get(id) as Y.Map<unknown>) ?? null) : null;
}

function put(cells: Y.Map<Y.Map<unknown>>, key: string, text: string) {
  const c = cells.get(key);
  if (!text) {
    if (c && c.get("s") != null) c.delete("in");
    else if (c) cells.delete(key);
    return;
  }
  if (c) {
    if (c.get("in") !== text) c.set("in", text);
    return;
  }
  const n = new Y.Map<unknown>();
  n.set("in", text);
  cells.set(key, n);
}

/** The database a live view follows, or null. */
export function linkOf(doc: Y.Doc, block: string): string | null {
  const l = blockMap(doc, block)?.get("link");
  return l instanceof Y.Map ? (String(l.get("db") ?? "") || null) : null;
}

/**
 * A new Spreadsheet block named `name`. With `link`, a live view of that database (`values` is
 * ignored); without, the `values` (header first) as plain inputs. Returns the block id.
 */
export function createSheetFrom(doc: Y.Doc, name: string, values: string[][], link?: { db: string; snap: LinkedDb }): string {
  const block = newId(10);
  const sheet = newId();
  const live = link && link.snap.fields.every((f) => SAFE.test(f.id)) && link.snap.rows.every((r) => SAFE.test(r.id) && r.id !== HEADER_ROW);
  const rowIds = live ? [HEADER_ROW, ...link!.snap.rows.map((r) => r.id)] : values.map(() => newId());
  const colIds = live ? link!.snap.fields.map((f) => f.id) : Array.from({ length: Math.max(0, ...values.map((r) => r.length)) }, () => newId());
  rowIds.push(...Array.from({ length: PAD_ROWS }, () => newId()));
  colIds.push(...Array.from({ length: PAD_COLS }, () => newId()));
  doc.transact(() => {
    const s = new Y.Map<unknown>();
    s.set("name", name.slice(0, 31) || "Sheet1");
    const r = new Y.Array<string>();
    r.push(rowIds);
    const c = new Y.Array<string>();
    c.push(colIds);
    const cells = new Y.Map<Y.Map<unknown>>();
    for (const k of ["rows", "cols"] as const) s.set(k, k === "rows" ? r : c);
    s.set("cells", cells);
    for (const k of ["widths", "heights"]) s.set(k, new Y.Map());
    const fz = new Y.Map<number>();
    if (live) fz.set("rows", 1);
    s.set("freeze", fz);
    const b = new Y.Map<unknown>();
    const order = new Y.Array<string>();
    order.push([sheet]);
    const sheets = new Y.Map<unknown>();
    sheets.set(sheet, s);
    b.set("order", order);
    b.set("sheets", sheets);
    b.set("styles", new Y.Map());
    if (live) {
      const l = new Y.Map<unknown>();
      l.set("db", link!.db);
      b.set("link", l);
    } else values.forEach((row, i) => row.forEach((t, j) => t && put(cells, `${rowIds[i]}:${colIds[j]}`, t)));
    sheetsRoot(doc).set(block, b);
    if (live) syncLinked(doc, block, link!.snap, true);
  }, LINK_ORIGIN);
  return block;
}

/**
 * Writes the database into a live view. `structure`: also add and remove record rows and field
 * columns (only the person whose change it was does that, so two people never insert the same
 * row); otherwise only values of rows and columns already there.
 */
export function syncLinked(doc: Y.Doc, block: string, snap: LinkedDb, structure: boolean) {
  const s = firstSheet(doc, block);
  if (!s) return;
  const rows = s.get("rows") as Y.Array<string>;
  const cols = s.get("cols") as Y.Array<string>;
  const cells = s.get("cells") as Y.Map<Y.Map<unknown>>;
  const fields = snap.fields.filter((f) => SAFE.test(f.id));
  const recs = snap.rows.filter((r) => SAFE.test(r.id) && r.id !== HEADER_ROW);
  const l = blockMap(doc, block)?.get("link") as Y.Map<unknown> | undefined;
  doc.transact(() => {
    if (structure && l) {
      const known = (k: string): string[] => {
        try {
          return JSON.parse(String(l.get(k) ?? "[]"));
        } catch {
          return [];
        }
      };
      const sync = (arr: Y.Array<string>, want: string[], prev: string[], start: number, dropCells: (id: string) => void) => {
        const keep = new Set(want);
        // Gone: delete from the end so indices hold.
        const cur = arr.toArray();
        for (let i = cur.length - 1; i >= 0; i--)
          if (prev.includes(cur[i]) && !keep.has(cur[i])) {
            arr.delete(i, 1);
            dropCells(cur[i]);
          }
        // New: after the one before it in `want`, else at `start`.
        let after = start - 1;
        for (const id of want) {
          const now = arr.toArray();
          const at = now.indexOf(id);
          if (at >= 0) {
            after = at;
            continue;
          }
          arr.insert(after + 1, [id]);
          after += 1;
        }
      };
      const drop = (pos: 0 | 1) => (id: string) => {
        for (const k of [...cells.keys()]) if (k.split(":")[pos] === id) cells.delete(k);
      };
      sync(rows, recs.map((r) => r.id), known("rows"), 1, drop(0));
      sync(cols, fields.map((f) => f.id), known("cols"), 0, drop(1));
      l.set("rows", JSON.stringify(recs.map((r) => r.id)));
      l.set("cols", JSON.stringify(fields.map((f) => f.id)));
    }
    const rowSet = new Set(rows.toArray());
    const colSet = new Set(cols.toArray());
    const fi = new Map(snap.fields.map((f, i) => [f.id, i]));
    for (const f of fields) if (colSet.has(f.id)) put(cells, `${HEADER_ROW}:${f.id}`, f.name);
    for (const r of recs) {
      if (!rowSet.has(r.id)) continue;
      for (const f of fields) if (colSet.has(f.id)) put(cells, `${r.id}:${f.id}`, r.cells[fi.get(f.id)!] ?? "");
    }
  }, LINK_ORIGIN);
}

/**
 * After someone edits a live view: the field cells that differ from the database, to write back
 * (`text` as typed), and formulas or header edits put back. `refused` counts formulas refused.
 */
export function linkedEdits(doc: Y.Doc, block: string, snap: LinkedDb): { writes: { row: string; field: string; text: string }[]; refused: number } {
  const s = firstSheet(doc, block);
  const out = { writes: [] as { row: string; field: string; text: string }[], refused: 0 };
  if (!s) return out;
  const cells = s.get("cells") as Y.Map<Y.Map<unknown>>;
  const input = (k: string) => {
    const v = cells.get(k)?.get("in");
    return typeof v === "string" ? v : "";
  };
  doc.transact(() => {
    for (const f of snap.fields) if (input(`${HEADER_ROW}:${f.id}`) !== f.name) put(cells, `${HEADER_ROW}:${f.id}`, f.name);
    for (const r of snap.rows)
      snap.fields.forEach((f, i) => {
        const k = `${r.id}:${f.id}`;
        const was = r.cells[i] ?? "";
        const now = input(k);
        if (now === was || !cells.has(k) && !was) return;
        if (now.startsWith("=")) {
          out.refused++;
          put(cells, k, was);
        } else out.writes.push({ row: r.id, field: f.id, text: now });
      });
  }, LINK_ORIGIN);
  return out;
}
