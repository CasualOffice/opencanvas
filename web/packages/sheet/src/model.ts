// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The Spreadsheet block's Yjs model (ADR-080 §3, SHEET-02). One root map, `sheets`, holds every
// spreadsheet block by id:
//
//   sheets[blockId]: Y.Map {
//     order:  Y.Array<sheetId>                 tab order
//     sheets: Y.Map<sheetId, Y.Map {
//       name:    string
//       rows:    Y.Array<rowId>                the grid's rows, in order (fixed size, grown on request)
//       cols:    Y.Array<colId>
//       cells:   Y.Map<"rowId:colId", Y.Map { in: string, s?: string }>   what was typed (stored form)
//       widths:  Y.Map<colId, number>          rem
//       heights: Y.Map<rowId, number>
//       freeze:  Y.Map { rows?: number, cols?: number }
//     }>
//     styles: Y.Map<styleKey, string>          JSON of a cell style, shared by key
//   }
//
// A formula's references are stored as row and column ids (crates/oc-sheet refs); the engine
// turns them into A1. Inserting rows is one insert into `rows`: no formula is rewritten, so two
// people inserting rows and typing formulas at the same time converge on the same cells. Values
// are computed on each client and never stored.

import * as Y from "yjs";
import type { EngineSheet } from "./engine/engine";

/** The grid a new sheet starts with (as Google Sheets: rows and columns are added on request). */
export const NEW_ROWS = 100;
export const NEW_COLS = 26;
/** Excel's limits; a block's grid never grows past them. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A short random id: no `$ ; : !`, as stored references require. */
export function newId(n = 8): string {
  let s = "";
  const r = crypto.getRandomValues(new Uint8Array(n));
  for (const b of r) s += ID_CHARS[b % ID_CHARS.length];
  return s;
}

export const sheetsRoot = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("sheets");
export const blockMap = (doc: Y.Doc, block: string) => sheetsRoot(doc).get(block) ?? null;

function sheetMap(doc: Y.Doc, block: string, sheet: string): Y.Map<unknown> | null {
  const s = blockMap(doc, block)?.get("sheets");
  return s instanceof Y.Map ? ((s.get(sheet) as Y.Map<unknown>) ?? null) : null;
}

function arr(m: Y.Map<unknown>, key: string): Y.Array<string> {
  return m.get(key) as Y.Array<string>;
}

function newSheet(name: string, rows = NEW_ROWS, cols = NEW_COLS): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("name", name);
  const r = new Y.Array<string>();
  r.push(Array.from({ length: rows }, () => newId()));
  const c = new Y.Array<string>();
  c.push(Array.from({ length: cols }, () => newId()));
  m.set("rows", r);
  m.set("cols", c);
  m.set("cells", new Y.Map());
  m.set("widths", new Y.Map());
  m.set("heights", new Y.Map());
  m.set("freeze", new Y.Map());
  return m;
}

/** A new spreadsheet block with one sheet; returns `[blockId, sheetId]`. */
export function createSheetBlock(doc: Y.Doc, name = "Sheet1"): [string, string] {
  const block = newId(10);
  const sheet = newId();
  doc.transact(() => {
    const b = new Y.Map<unknown>();
    const order = new Y.Array<string>();
    const sheets = new Y.Map<unknown>();
    order.push([sheet]);
    sheets.set(sheet, newSheet(name));
    b.set("order", order);
    b.set("sheets", sheets);
    b.set("styles", new Y.Map());
    sheetsRoot(doc).set(block, b);
  });
  return [block, sheet];
}

/** Adds a sheet after the others; returns its id. Names are unique without case (Excel's rule). */
export function addSheet(doc: Y.Doc, block: string, name?: string): string {
  const b = blockMap(doc, block)!;
  const taken = new Set(readSheets(doc, block).map((s) => s.name.toLowerCase()));
  let n = (b.get("order") as Y.Array<string>).length + 1;
  let pick = name ?? `Sheet${n}`;
  while (taken.has(pick.toLowerCase())) pick = name ? `${name} (${n++})` : `Sheet${++n}`;
  const id = newId();
  doc.transact(() => {
    (b.get("sheets") as Y.Map<unknown>).set(id, newSheet(pick));
    (b.get("order") as Y.Array<string>).push([id]);
  });
  return id;
}

export function renameSheet(doc: Y.Doc, block: string, sheet: string, name: string) {
  sheetMap(doc, block, sheet)?.set("name", name);
}

/** Deletes a sheet; references to it read `#REF!`. The last sheet is never deleted. */
export function deleteSheet(doc: Y.Doc, block: string, sheet: string) {
  const b = blockMap(doc, block)!;
  const order = b.get("order") as Y.Array<string>;
  if (order.length <= 1) return;
  doc.transact(() => {
    const i = order.toArray().indexOf(sheet);
    if (i >= 0) order.delete(i, 1);
    (b.get("sheets") as Y.Map<unknown>).delete(sheet);
  });
}

/** Sets what a cell holds in stored form (empty clears it). */
export function setInput(doc: Y.Doc, block: string, sheet: string, row: string, col: string, stored: string) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  const cells = s.get("cells") as Y.Map<Y.Map<unknown>>;
  const key = `${row}:${col}`;
  doc.transact(() => {
    if (!stored) {
      const c = cells.get(key);
      if (c && c.get("s") != null) c.delete("in");
      else cells.delete(key);
      return;
    }
    let c = cells.get(key);
    if (!c) {
      c = new Y.Map();
      cells.set(key, c);
    }
    c.set("in", stored);
  });
}

function insertIds(doc: Y.Doc, block: string, sheet: string, key: "rows" | "cols", at: number, n: number, max: number) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return [];
  const a = arr(s, key);
  const count = Math.max(0, Math.min(n, max - a.length));
  const ids = Array.from({ length: count }, () => newId());
  if (count) a.insert(Math.max(0, Math.min(at, a.length)), ids);
  return ids;
}

/** Inserts `n` rows before index `at` (`at` = row count appends). */
export const insertRows = (doc: Y.Doc, block: string, sheet: string, at: number, n = 1) => insertIds(doc, block, sheet, "rows", at, n, MAX_ROWS);
export const insertCols = (doc: Y.Doc, block: string, sheet: string, at: number, n = 1) => insertIds(doc, block, sheet, "cols", at, n, MAX_COLS);

function deleteIds(doc: Y.Doc, block: string, sheet: string, key: "rows" | "cols", at: number, n: number) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  const a = arr(s, key);
  // A grid keeps at least one row and one column.
  const count = Math.max(0, Math.min(n, a.length - at, a.length - 1));
  if (!count) return;
  doc.transact(() => {
    const gone = new Set(a.slice(at, at + count));
    a.delete(at, count);
    // Their cells go with them (references to them read #REF!).
    const cells = s.get("cells") as Y.Map<unknown>;
    for (const k of [...cells.keys()]) {
      const [r, c] = k.split(":");
      if (gone.has(key === "rows" ? r : c)) cells.delete(k);
    }
  });
}

export const deleteRows = (doc: Y.Doc, block: string, sheet: string, at: number, n = 1) => deleteIds(doc, block, sheet, "rows", at, n);
export const deleteCols = (doc: Y.Doc, block: string, sheet: string, at: number, n = 1) => deleteIds(doc, block, sheet, "cols", at, n);

/** The block's sheets in tab order, as the engine takes them. */
export function readSheets(doc: Y.Doc, block: string): EngineSheet[] {
  const b = blockMap(doc, block);
  if (!b) return [];
  const sheets = b.get("sheets") as Y.Map<Y.Map<unknown>>;
  return (b.get("order") as Y.Array<string>)
    .toArray()
    .map((id) => {
      const s = sheets.get(id);
      if (!s) return null;
      const cells: Record<string, string> = {};
      (s.get("cells") as Y.Map<Y.Map<unknown>>).forEach((c, k) => {
        const v = c.get("in");
        if (typeof v === "string" && v) cells[k] = v;
      });
      return { id, name: String(s.get("name") ?? ""), rows: arr(s, "rows").toArray(), cols: arr(s, "cols").toArray(), cells };
    })
    .filter((x): x is EngineSheet => !!x);
}
