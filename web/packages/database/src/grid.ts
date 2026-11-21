// Spreadsheet-style helpers for the table view: cell ranges, clipboard text, keyboard moves.
import type { OcUser } from "@opencanvas/ui";
import { cellToText } from "./model";
import type { DbField, DbRow } from "./types";

/** A cell position in the visible table: row index and field (column) index. */
export interface CellPos {
  r: number;
  c: number;
}

/** A rectangular selection: the anchor (where it started) and the focus (the active cell). */
export interface CellRange {
  a: CellPos;
  f: CellPos;
}

export function rangeBounds(g: CellRange): { r0: number; r1: number; c0: number; c1: number } {
  return { r0: Math.min(g.a.r, g.f.r), r1: Math.max(g.a.r, g.f.r), c0: Math.min(g.a.c, g.f.c), c1: Math.max(g.a.c, g.f.c) };
}

export const inRange = (g: CellRange | null, r: number, c: number) => {
  if (!g) return false;
  const b = rangeBounds(g);
  return r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
};

export const isMulti = (g: CellRange | null) => !!g && (g.a.r !== g.f.r || g.a.c !== g.f.c);

/**
 * Where a navigation key moves the active cell, clamped to the grid. `null` for keys that
 * don't navigate. Mod = Ctrl/Cmd (jump to the edge).
 */
export function moveCell(p: CellPos, key: string, rows: number, cols: number, mod = false): CellPos | null {
  const clamp = (r: number, c: number) => ({ r: Math.max(0, Math.min(rows - 1, r)), c: Math.max(0, Math.min(cols - 1, c)) });
  switch (key) {
    case "ArrowUp":
      return clamp(mod ? 0 : p.r - 1, p.c);
    case "ArrowDown":
      return clamp(mod ? rows - 1 : p.r + 1, p.c);
    case "ArrowLeft":
      return clamp(p.r, mod ? 0 : p.c - 1);
    case "ArrowRight":
      return clamp(p.r, mod ? cols - 1 : p.c + 1);
    case "Home":
      return clamp(mod ? 0 : p.r, 0);
    case "End":
      return clamp(mod ? rows - 1 : p.r, cols - 1);
    case "PageUp":
      return clamp(p.r - 10, p.c);
    case "PageDown":
      return clamp(p.r + 10, p.c);
  }
  return null;
}

/** One cell as clipboard text: single line, tabs flattened (TSV-safe unless quoted). */
function tsvCell(s: string): string {
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The cells in `g` as tab-separated text (Excel / Sheets compatible). */
export function rangeToTsv(g: CellRange, rows: DbRow[], fields: DbField[], users: OcUser[] = []): string {
  const b = rangeBounds(g);
  const out: string[] = [];
  for (let r = b.r0; r <= b.r1; r++) {
    const row = rows[r];
    if (!row) continue;
    const line: string[] = [];
    for (let c = b.c0; c <= b.c1; c++) {
      const f = fields[c];
      line.push(f ? tsvCell(cellToText(f, row.v[f.id], users)) : "");
    }
    out.push(line.join("\t"));
  }
  return out.join("\n");
}

/** The same cells as an HTML table, so rich editors and spreadsheets paste a real grid. */
export function rangeToHtml(g: CellRange, rows: DbRow[], fields: DbField[], users: OcUser[] = []): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const b = rangeBounds(g);
  let h = "<table>";
  for (let r = b.r0; r <= b.r1; r++) {
    const row = rows[r];
    if (!row) continue;
    h += "<tr>";
    for (let c = b.c0; c <= b.c1; c++) h += "<td>" + (fields[c] ? esc(cellToText(fields[c], row.v[fields[c].id], users)) : "") + "</td>";
    h += "</tr>";
  }
  return h + "</table>";
}

/**
 * Parse clipboard text from a spreadsheet: rows by newline, cells by tab, with Excel-style
 * quoting (`"a\tb"`, `""`, newlines inside quotes). A trailing newline adds no row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") q = true;
    else if (ch === "\t") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** True when pasted text is a grid (more than one cell), as opposed to text for one cell. */
export const isGridText = (t: string) => /\t/.test(t) || /\n./.test(t.replace(/\r/g, "").replace(/\n+$/, ""));
