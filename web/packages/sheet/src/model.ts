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

/* ---------------------------------------------------------------- grid UI (SHEET-04) */

/** The sheet's Y.Map (rows, cols, cells, widths, heights, freeze), or null. */
export const sheetOf = sheetMap;

/** A short stable key for a style's JSON: equal styles share one entry in `styles`. */
export function styleKey(json: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
  return "s" + (h >>> 0).toString(36);
}

/** A cell style by key (JSON in the block's `styles`), parsed; undefined when unset. */
export function readStyle<T = Record<string, unknown>>(doc: Y.Doc, block: string, key: unknown): T | undefined {
  if (typeof key !== "string") return undefined;
  const j = (blockMap(doc, block)?.get("styles") as Y.Map<string> | undefined)?.get(key);
  if (!j) return undefined;
  try {
    return JSON.parse(j) as T;
  } catch {
    return undefined;
  }
}

function writeStyle(doc: Y.Doc, block: string, map: Y.Map<Y.Map<unknown>>, key: string, next: Record<string, unknown> | undefined) {
  const cell = map.get(key);
  const keys = next ? Object.keys(next).filter((k) => next[k] != null && next[k] !== false).sort() : [];
  if (!keys.length) {
    if (cell?.get("s") != null) {
      if (cell.get("in")) cell.delete("s");
      else map.delete(key);
    }
    return;
  }
  const json = JSON.stringify(next, keys);
  const sk = styleKey(json);
  const styles = blockMap(doc, block)!.get("styles") as Y.Map<string>;
  if (styles.get(sk) !== json) styles.set(sk, json);
  let c2 = cell;
  if (!c2) {
    c2 = new Y.Map();
    map.set(key, c2);
  }
  if (c2.get("s") !== sk) c2.set("s", sk);
}

/** Merges `patch` into the style of each cell (`[rowId, colId]`); a key set to null or false is
 *  removed. A cell left with no style and no input is deleted. */
export function patchStyle(doc: Y.Doc, block: string, sheet: string, cells: [string, string][], patch: Record<string, unknown>) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  const map = s.get("cells") as Y.Map<Y.Map<unknown>>;
  doc.transact(() => {
    for (const [r, c] of cells) {
      const key = `${r}:${c}`;
      const next: Record<string, unknown> = { ...(readStyle(doc, block, map.get(key)?.get("s")) ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === false) delete next[k];
        else next[k] = v;
      }
      writeStyle(doc, block, map, key, next);
    }
  });
}

/** Sets a cell's style outright (paste with formats); undefined clears it. */
export function setStyle(doc: Y.Doc, block: string, sheet: string, row: string, col: string, style: Record<string, unknown> | undefined) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  doc.transact(() => writeStyle(doc, block, s.get("cells") as Y.Map<Y.Map<unknown>>, `${row}:${col}`, style));
}

/** A column's width or a row's height in rem (null resets it to the default). */
export function setSize(doc: Y.Doc, block: string, sheet: string, kind: "widths" | "heights", id: string, rem: number | null) {
  const m = sheetMap(doc, block, sheet)?.get(kind) as Y.Map<number> | undefined;
  if (!m) return;
  if (rem == null) m.delete(id);
  else m.set(id, Math.round(rem * 1000) / 1000);
}

/** Freezes the first `rows` rows and `cols` columns (0 unfreezes). */
export function setFreeze(doc: Y.Doc, block: string, sheet: string, rows: number, cols: number) {
  const m = sheetMap(doc, block, sheet)?.get("freeze") as Y.Map<number> | undefined;
  if (!m) return;
  doc.transact(() => {
    if (rows > 0) m.set("rows", rows);
    else m.delete("rows");
    if (cols > 0) m.set("cols", cols);
    else m.delete("cols");
  });
}

/**
 * A sheet's filter (Data → Create a filter): the header row and the columns it covers, by id,
 * and per column the values hidden. Stored as JSON on the sheet (`filter`).
 */
export interface SheetFilter {
  row: string;
  cols: string[];
  hide: Record<string, string[]>;
}
export function readFilter(doc: Y.Doc, block: string, sheet: string): SheetFilter | null {
  const j = sheetMap(doc, block, sheet)?.get("filter");
  if (typeof j !== "string") return null;
  try {
    return JSON.parse(j) as SheetFilter;
  } catch {
    return null;
  }
}
export function setFilter(doc: Y.Doc, block: string, sheet: string, f: SheetFilter | null) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  if (f) s.set("filter", JSON.stringify(f));
  else s.delete("filter");
}

/** Puts the rows from index `from` in the order `ids` (a sort of that range). Formulas keep
 *  pointing at the same row ids, so a sort moves rows for real, as in Excel. */
export function reorderRows(doc: Y.Doc, block: string, sheet: string, from: number, ids: string[]) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  const a = arr(s, "rows");
  doc.transact(() => {
    a.delete(from, ids.length);
    a.insert(from, ids);
  });
}

/* ---- merges, hidden rows and columns, moves, tab order and colour (SHEET-04, frames 3b, 4c-4d, 5a) ----
 * Merges and hidden ids are plain keys on the sheet map (`m:<rowId>:<colId>` → `<rowId>:<colId>`
 * of the far corner; `h:<id>` → true), not a nested map: two people creating a nested map at the
 * same time would lose one of them. */

/** The sheet's merges: anchor `[rowId, colId]` → far corner `[rowId, colId]`. */
export function readMerges(doc: Y.Doc, block: string, sheet: string): [string, string, string, string][] {
  const s = sheetMap(doc, block, sheet);
  const out: [string, string, string, string][] = [];
  s?.forEach((v, k) => {
    if (!k.startsWith("m:") || typeof v !== "string") return;
    const [r0, c0] = k.slice(2).split(":");
    const [r1, c1] = v.split(":");
    out.push([r0, c0, r1, c1]);
  });
  return out;
}
export function setMerge(doc: Y.Doc, block: string, sheet: string, r0: string, c0: string, end: [string, string] | null) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  if (end) s.set(`m:${r0}:${c0}`, `${end[0]}:${end[1]}`);
  else s.delete(`m:${r0}:${c0}`);
}

/** Hidden rows and columns (ids). */
export function readHidden(doc: Y.Doc, block: string, sheet: string): Set<string> {
  const out = new Set<string>();
  sheetMap(doc, block, sheet)?.forEach((v, k) => k.startsWith("h:") && v && out.add(k.slice(2)));
  return out;
}
export function setHidden(doc: Y.Doc, block: string, sheet: string, ids: string[], hide: boolean) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  doc.transact(() => {
    for (const id of ids) {
      if (hide) s.set(`h:${id}`, true);
      else s.delete(`h:${id}`);
    }
  });
}

/** Moves `n` rows (or columns) at `from` to sit before index `to` (indexes before the move).
 *  The ids move, so formulas follow them. */
export function moveIds(doc: Y.Doc, block: string, sheet: string, key: "rows" | "cols", from: number, n: number, to: number) {
  const s = sheetMap(doc, block, sheet);
  if (!s || (to >= from && to <= from + n)) return;
  const a = arr(s, key);
  doc.transact(() => {
    const ids = a.slice(from, from + n);
    a.delete(from, n);
    a.insert(to > from ? to - n : to, ids);
  });
}

/** Moves a sheet's tab to index `to` (after removal). */
export function moveSheet(doc: Y.Doc, block: string, sheet: string, to: number) {
  const order = blockMap(doc, block)?.get("order") as Y.Array<string> | undefined;
  if (!order) return;
  const i = order.toArray().indexOf(sheet);
  if (i < 0 || i === to) return;
  doc.transact(() => {
    order.delete(i, 1);
    order.insert(Math.max(0, Math.min(to, order.length)), [sheet]);
  });
}
export function setSheetColor(doc: Y.Doc, block: string, sheet: string, tone: string | null) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  if (tone) s.set("color", tone);
  else s.delete("color");
}

/**
 * How many formulas (outside the deleted ids' own cells) name one of `ids` as a reference end:
 * deleting those rows or columns turns them into #REF! (4c). Stored references carry
 * `r<id>;` / `c<id>;` (with `$` when absolute).
 */
export function countRefs(doc: Y.Doc, block: string, kind: "rows" | "cols", sheet: string, ids: string[]): number {
  const b = blockMap(doc, block);
  if (!b || !ids.length) return 0;
  const p = kind === "rows" ? "r" : "c";
  const tokens = ids.flatMap((id) => [`${p}${id};`, `${p}$${id};`]);
  const gone = new Set(ids);
  let n = 0;
  (b.get("sheets") as Y.Map<Y.Map<unknown>>).forEach((s, sid) => {
    (s.get("cells") as Y.Map<Y.Map<unknown>>).forEach((c, k) => {
      const v = c.get("in");
      if (typeof v !== "string" || !v.startsWith("=")) return;
      if (sid === sheet && gone.has(k.split(":")[kind === "rows" ? 0 : 1])) return;
      if (tokens.some((t) => v.includes(t))) n++;
    });
  });
  return n;
}

/* ---- comments on cells (SHEET-07, frame 6b) ----
 * One plain key per comment on the sheet map, `n:<rowId>:<colId>:<commentId>` → JSON
 * `{ by, name, at, text }`: anchored to row and column ids, so a thread follows its cell through
 * inserts, moves and sorts, and two people commenting at once never lose one. */

export interface CellComment {
  id: string;
  /** Author's user id, and their name when written (shown when the id is no longer known). */
  by: string;
  name: string;
  /** Milliseconds since the epoch. */
  at: number;
  text: string;
}

/** Every thread on the sheet by `rowId:colId`, oldest comment first. */
export function readComments(doc: Y.Doc, block: string, sheet: string): Map<string, CellComment[]> {
  const out = new Map<string, CellComment[]>();
  sheetMap(doc, block, sheet)?.forEach((v, k) => {
    if (!k.startsWith("n:") || typeof v !== "string") return;
    const [r, c, id] = k.slice(2).split(":");
    try {
      const j = JSON.parse(v) as Partial<CellComment>;
      if (typeof j.text !== "string") return;
      const key = `${r}:${c}`;
      const list = out.get(key) ?? [];
      list.push({ id, by: String(j.by ?? ""), name: String(j.name ?? ""), at: Number(j.at) || 0, text: j.text });
      out.set(key, list);
    } catch {
      /* a malformed comment is skipped */
    }
  });
  for (const list of out.values()) list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  return out;
}

/** Adds a comment to the cell's thread; returns its id. */
export function addComment(doc: Y.Doc, block: string, sheet: string, row: string, col: string, c: { by: string; name: string; text: string }, at = Date.now()): string {
  const id = newId();
  sheetMap(doc, block, sheet)?.set(`n:${row}:${col}:${id}`, JSON.stringify({ by: c.by, name: c.name, at, text: c.text }));
  return id;
}

export function deleteComment(doc: Y.Doc, block: string, sheet: string, row: string, col: string, id: string) {
  sheetMap(doc, block, sheet)?.delete(`n:${row}:${col}:${id}`);
}

/* ---- charts floating over the sheet (SHEET-06, frame 4h) ----
 * `ch:<chartId>` → JSON `{ attrs, row, col }`: the chart block's attributes (the range as row and
 * column ids) and the cell its top-left corner sits on. */

export interface FloatChart {
  id: string;
  attrs: Record<string, unknown>;
  row: string;
  col: string;
}

export function readCharts(doc: Y.Doc, block: string, sheet: string): FloatChart[] {
  const out: FloatChart[] = [];
  sheetMap(doc, block, sheet)?.forEach((v, k) => {
    if (!k.startsWith("ch:") || typeof v !== "string") return;
    try {
      const j = JSON.parse(v) as Partial<FloatChart>;
      if (j.attrs && typeof j.row === "string" && typeof j.col === "string") out.push({ id: k.slice(3), attrs: j.attrs, row: j.row, col: j.col });
    } catch {
      /* a malformed chart is skipped */
    }
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function setChart(doc: Y.Doc, block: string, sheet: string, id: string, v: Omit<FloatChart, "id"> | null) {
  const s = sheetMap(doc, block, sheet);
  if (!s) return;
  if (v) s.set(`ch:${id}`, JSON.stringify(v));
  else s.delete(`ch:${id}`);
}
