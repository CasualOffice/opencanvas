// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The Spreadsheet block's grid logic (SHEET-04), kept free of React and Yjs so it is tested on
// its own: A1 names, selection, the Excel keyboard model, fill, clipboard parsing and number
// formats. Positions are indexes into the sheet's current row and column order.

export interface Pos {
  r: number;
  c: number;
}
/** A selection: `anchor` is the active cell, `focus` the end Shift moves. */
export interface Sel {
  anchor: Pos;
  focus: Pos;
  /** Set when Enter or Tab walk the active cell through a range: the range stays selected. */
  range?: Rect;
}
export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export const at = (r: number, c: number): Sel => ({ anchor: { r, c }, focus: { r, c } });
export const rectOf = (s: Sel): Rect =>
  s.range ?? {
  r0: Math.min(s.anchor.r, s.focus.r),
  c0: Math.min(s.anchor.c, s.focus.c),
  r1: Math.max(s.anchor.r, s.focus.r),
  c1: Math.max(s.anchor.c, s.focus.c),
  };
export const inRect = (q: Rect, r: number, c: number) => r >= q.r0 && r <= q.r1 && c >= q.c0 && c <= q.c1;
export const rectSize = (q: Rect) => (q.r1 - q.r0 + 1) * (q.c1 - q.c0 + 1);

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
/** A -> 0, AA -> 26; -1 when not letters. */
export function colIndex(s: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(s)) return -1;
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const a1 = (p: Pos) => `${colName(p.c)}${p.r + 1}`;
export function rectA1(q: Rect): string {
  return q.r0 === q.r1 && q.c0 === q.c1 ? a1({ r: q.r0, c: q.c0 }) : `${a1({ r: q.r0, c: q.c0 })}:${a1({ r: q.r1, c: q.c1 })}`;
}

/** The name box: `B3`, `$B$3`, `A1:C4` (either order). Null when it is not a reference. */
export function parseRef(s: string): Rect | null {
  const one = (t: string): Pos | null => {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(t.trim());
    if (!m) return null;
    const r = Number(m[2]) - 1;
    return r < 0 ? null : { r, c: colIndex(m[1]) };
  };
  const parts = s.split(":");
  if (parts.length > 2) return null;
  const a = one(parts[0]);
  const b = parts.length === 2 ? one(parts[1]) : a;
  if (!a || !b) return null;
  return rectOf({ anchor: a, focus: b });
}

/** What the keyboard model needs to know about a sheet. */
export interface Grid {
  rows: number;
  cols: number;
  /** A cell holds something (Ctrl+arrow, Ctrl+A, End). */
  filled(r: number, c: number): boolean;
  /** Rows hidden by a filter (arrows skip them). */
  hidden?(r: number): boolean;
  /** Rows a page holds (PageUp, PageDown). */
  page: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** One step from row `r` by `d` rows, skipping hidden rows; stays when there is nowhere to go. */
function stepRow(g: Grid, r: number, d: number): number {
  let n = r + d;
  while (n >= 0 && n < g.rows && g.hidden?.(n)) n += Math.sign(d);
  return n >= 0 && n < g.rows ? n : r;
}

/**
 * Ctrl+arrow (Excel): inside a filled run, to its last filled cell; on an edge of a run or an
 * empty cell, to the next filled cell; nothing further, to the edge of the sheet.
 */
export function jump(g: Grid, p: Pos, dr: number, dc: number): Pos {
  const ok = (r: number, c: number) => r >= 0 && c >= 0 && r < g.rows && c < g.cols;
  const next = (q: Pos): Pos => (dr ? { r: stepRow(g, q.r, dr), c: q.c } : { r: q.r, c: q.c + dc });
  let q = next(p);
  if (!ok(q.r, q.c) || (q.r === p.r && q.c === p.c)) return p;
  if (g.filled(p.r, p.c) && g.filled(q.r, q.c)) {
    for (;;) {
      const n = next(q);
      if (!ok(n.r, n.c) || (n.r === q.r && n.c === q.c) || !g.filled(n.r, n.c)) return q;
      q = n;
    }
  }
  for (;;) {
    if (g.filled(q.r, q.c)) return q;
    const n = next(q);
    if (!ok(n.r, n.c) || (n.r === q.r && n.c === q.c)) return q;
    q = n;
  }
}

/** Ctrl+A's first press: the filled region around `p` (Excel's current region), grown while any
 *  cell touching its border (diagonals too) is filled. Null on an isolated empty cell. */
export function currentRegion(g: Grid, p: Pos): Rect | null {
  const q: Rect = { r0: p.r, c0: p.c, r1: p.r, c1: p.c };
  const any = (r0: number, c0: number, r1: number, c1: number) => {
    for (let r = Math.max(0, r0); r <= Math.min(g.rows - 1, r1); r++)
      for (let c = Math.max(0, c0); c <= Math.min(g.cols - 1, c1); c++) if (g.filled(r, c)) return true;
    return false;
  };
  for (let grew = true, n = 0; grew && n < 10_000; n++) {
    grew = false;
    if (q.r0 > 0 && any(q.r0 - 1, q.c0 - 1, q.r0 - 1, q.c1 + 1)) (q.r0--, (grew = true));
    if (q.r1 < g.rows - 1 && any(q.r1 + 1, q.c0 - 1, q.r1 + 1, q.c1 + 1)) (q.r1++, (grew = true));
    if (q.c0 > 0 && any(q.r0 - 1, q.c0 - 1, q.r1 + 1, q.c0 - 1)) (q.c0--, (grew = true));
    if (q.c1 < g.cols - 1 && any(q.r0 - 1, q.c1 + 1, q.r1 + 1, q.c1 + 1)) (q.c1++, (grew = true));
  }
  return rectSize(q) === 1 && !g.filled(p.r, p.c) ? null : q;
}

/** The last row and column that hold anything (Ctrl+End). */
export function lastUsed(g: Grid): Pos {
  let r = 0;
  let c = 0;
  for (let i = 0; i < g.rows; i++) for (let j = 0; j < g.cols; j++) if (g.filled(i, j)) (r = Math.max(r, i), (c = Math.max(c, j)));
  return { r, c };
}

export interface Key {
  key: string;
  shift?: boolean;
  /** Ctrl, or Cmd on a Mac. */
  mod?: boolean;
}

/**
 * The selection after a navigation key, or null when the key is not one. Arrows move, Shift
 * extends, Ctrl jumps, Home/End/PageUp/PageDown, Ctrl+Home/End, Ctrl+A (region, then sheet),
 * Enter/Tab outside an edit (Shift reverses).
 */
export function navigate(g: Grid, sel: Sel, k: Key): Sel | null {
  const last = { r: g.rows - 1, c: g.cols - 1 };
  const from = k.shift ? sel.focus : sel.anchor;
  let to: Pos | null = null;
  const arrow: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (arrow[k.key]) {
    const [dr, dc] = arrow[k.key];
    to = k.mod ? jump(g, from, dr, dc) : dr ? { r: stepRow(g, from.r, dr), c: from.c } : { r: from.r, c: clamp(from.c + dc, 0, last.c) };
  } else if (k.key === "Home") to = k.mod ? { r: 0, c: 0 } : { r: from.r, c: 0 };
  else if (k.key === "End") {
    if (k.mod) to = lastUsed(g);
    else {
      let c = last.c;
      while (c > 0 && !g.filled(from.r, c)) c--;
      to = { r: from.r, c };
    }
  } else if (k.key === "PageDown" || k.key === "PageUp") {
    const d = k.key === "PageDown" ? 1 : -1;
    let r = from.r;
    for (let i = 0; i < Math.max(1, g.page); i++) r = stepRow(g, r, d);
    to = { r, c: from.c };
  } else if (k.mod && (k.key === "a" || k.key === "A")) {
    const q = rectOf(sel);
    const reg = currentRegion(g, sel.anchor);
    const whole: Rect = { r0: 0, c0: 0, r1: last.r, c1: last.c };
    const pick = reg && !(reg.r0 === q.r0 && reg.c0 === q.c0 && reg.r1 === q.r1 && reg.c1 === q.c1) ? reg : whole;
    return { anchor: sel.anchor, focus: { r: pick.r0 === sel.anchor.r ? pick.r1 : pick.r0, c: pick.c0 === sel.anchor.c ? pick.c1 : pick.c0 } };
  } else if (k.key === "Enter" || k.key === "Tab") {
    const down = k.key === "Enter";
    const d = k.shift ? -1 : 1;
    const q = rectOf(sel);
    // Inside a multi-cell selection Enter and Tab walk through it, as in Excel.
    if (rectSize(q) > 1) {
      let { r, c } = sel.anchor;
      if (down) {
        r += d;
        if (r > q.r1) (r = q.r0, (c = c + 1 > q.c1 ? q.c0 : c + 1));
        if (r < q.r0) (r = q.r1, (c = c - 1 < q.c0 ? q.c1 : c - 1));
      } else {
        c += d;
        if (c > q.c1) (c = q.c0, (r = r + 1 > q.r1 ? q.r0 : r + 1));
        if (c < q.c0) (c = q.c1, (r = r - 1 < q.r0 ? q.r1 : r - 1));
      }
      return { anchor: { r, c }, focus: { r, c }, range: q };
    }
    const p = sel.anchor;
    return at(down ? stepRow(g, p.r, d) : p.r, down ? p.c : clamp(p.c + d, 0, last.c));
  } else return null;
  to = { r: clamp(to.r, 0, last.r), c: clamp(to.c, 0, last.c) };
  return k.shift ? { anchor: sel.anchor, focus: to } : at(to.r, to.c);
}

/* ---------------------------------------------------------------- fill */

/** A number as the engine shows it (plain decimal, no grouping). */
const NUM = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
export const isNumber = (s: string) => NUM.test(s.trim());

/**
 * What the fill handle writes into `to` from the source `from` (Excel): formulas are copied with
 * relative references shifted; two or more numbers in a row or column continue their step; other
 * cells are repeated. `get` reads a cell's input as typed (A1 formulas), `shift` moves a formula.
 * Returns `[row, col, input]` for every target cell outside the source.
 */
export function fill(from: Rect, to: Rect, get: (r: number, c: number) => string, shift: (src: string, dr: number, dc: number) => string): [number, number, string][] {
  const out: [number, number, string][] = [];
  const down = to.r0 < from.r0 || to.r1 > from.r1;
  const h = from.r1 - from.r0 + 1;
  const w = from.c1 - from.c0 + 1;
  const mod = (a: number, n: number) => ((a % n) + n) % n;
  // One series per column (filling down/up) or per row (filling across).
  const lines = down ? w : h;
  for (let k = 0; k < lines; k++) {
    const src = Array.from({ length: down ? h : w }, (_, i) => (down ? get(from.r0 + i, from.c0 + k) : get(from.r0 + k, from.c0 + i)));
    const nums = src.every((s) => isNumber(s)) && src.length >= 2 ? src.map(Number) : null;
    const step = nums ? (nums[nums.length - 1] - nums[0]) / (nums.length - 1) : 0;
    const linear = nums?.every((v, i) => Math.abs(v - (nums[0] + step * i)) < 1e-9);
    const lo = down ? to.r0 : to.c0;
    const hi = down ? to.r1 : to.c1;
    const s0 = down ? from.r0 : from.c0;
    const s1 = down ? from.r1 : from.c1;
    for (let i = lo; i <= hi; i++) {
      if (i >= s0 && i <= s1) continue;
      const r = down ? i : from.r0 + k;
      const c = down ? from.c0 + k : i;
      let v: string;
      if (nums && linear) {
        const n = nums[0] + step * (i - s0);
        v = String(Math.round(n * 1e10) / 1e10);
      } else {
        const j = mod(i - s0, src.length);
        const s = src[j];
        const d = i - (s0 + j);
        v = s.startsWith("=") ? shift(s, down ? d : 0, down ? 0 : d) : s;
      }
      out.push([r, c, v]);
    }
  }
  return out;
}

/** The target of a fill drag: the source grown towards the pointer along one axis. */
export function fillTarget(from: Rect, p: Pos): Rect {
  const dr = p.r < from.r0 ? p.r - from.r0 : p.r > from.r1 ? p.r - from.r1 : 0;
  const dc = p.c < from.c0 ? p.c - from.c0 : p.c > from.c1 ? p.c - from.c1 : 0;
  if (Math.abs(dr) >= Math.abs(dc)) return dr < 0 ? { ...from, r0: p.r } : dr > 0 ? { ...from, r1: p.r } : from;
  return dc < 0 ? { ...from, c0: p.c } : { ...from, c1: p.c };
}

/* ---------------------------------------------------------------- clipboard */

/** TSV as Excel and Google Sheets write it: tabs, CRLF or LF, quoted fields with `""`. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  let fieldStart = true;
  const t = text.replace(/\r\n?/g, "\n");
  while (i < t.length) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') (cell += '"', (i += 2));
      else if (ch === '"') (quoted = false, i++);
      else (cell += ch, i++);
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      i++;
    } else if (ch === "\t") {
      row.push(cell);
      cell = "";
      fieldStart = true;
      i++;
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      fieldStart = true;
      i++;
    } else {
      cell += ch;
      fieldStart = false;
      i++;
    }
  }
  if (cell || row.length || !fieldStart) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function toTsv(grid: string[][]): string {
  const q = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return grid.map((r) => r.map(q).join("\t")).join("\n");
}

/** A pasted cell's style, as far as a sheet keeps it. */
export interface CellStyle {
  /** bold, italic, strikethrough */
  b?: boolean;
  i?: boolean;
  st?: boolean;
  /** text and fill colour (CSS colour) */
  fg?: string;
  bg?: string;
  al?: "l" | "c" | "r";
  /** number format and decimals */
  nf?: NumFmt;
  dp?: number;
}
export type NumFmt = "num" | "pct" | "cur" | "date" | "sci";

export interface PastedCell {
  v: string;
  st?: CellStyle;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The HTML a copy puts next to TSV (Excel and Sheets read its table). `data-oc` marks our own. */
export function toHtml(grid: PastedCell[][], source?: string): string {
  const css = (s?: CellStyle) => {
    if (!s) return "";
    const p: string[] = [];
    if (s.b) p.push("font-weight:bold");
    if (s.i) p.push("font-style:italic");
    if (s.st) p.push("text-decoration:line-through");
    if (s.fg) p.push(`color:${s.fg}`);
    if (s.bg) p.push(`background-color:${s.bg}`);
    if (s.al) p.push(`text-align:${{ l: "left", c: "center", r: "right" }[s.al]}`);
    return p.length ? ` style="${esc(p.join(";"))}"` : "";
  };
  const body = grid.map((r) => `<tr>${r.map((c) => `<td${css(c.st)}>${esc(c.v)}</td>`).join("")}</tr>`).join("");
  return `<table${source ? ` data-oc="${esc(source)}"` : ""}>${body}</table>`;
}

/** Reads the first table of pasted HTML (Excel, Google Sheets, our own); null without one. */
export function parseHtmlTable(html: string): { cells: PastedCell[][]; source: string | null } | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  // Excel puts class rules in a <style>; read the simple ones (font-weight, color, background).
  const classCss = new Map<string, string>();
  doc.querySelectorAll("style").forEach((st) => {
    for (const m of (st.textContent ?? "").matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) classCss.set(m[1], m[2]);
  });
  const cells: PastedCell[][] = [];
  const spans: number[] = [];
  table.querySelectorAll("tr").forEach((tr, ri) => {
    const row: PastedCell[] = [];
    let ci = 0;
    tr.querySelectorAll("td,th").forEach((td) => {
      while (spans[ci] > ri) row[ci++] = { v: "" };
      const el = td as HTMLElement;
      const style = [...el.classList].map((c) => classCss.get(c) ?? "").join(";") + ";" + (el.getAttribute("style") ?? "");
      const st = styleFrom(style, el);
      // Sheets' typed value when it gives one, else the text (with <br> as newlines).
      const raw = el.getAttribute("data-sheets-value");
      let v = (el.innerText ?? el.textContent ?? "").replace(/ /g, " ");
      if (el.querySelector("br")) v = [...el.childNodes].map((n) => (n.nodeName === "BR" ? "\n" : n.textContent)).join("");
      if (raw) {
        try {
          const j = JSON.parse(raw) as { 2?: string; 3?: number };
          if (typeof j[3] === "number") v = String(j[3]);
        } catch {
          /* keep the text */
        }
      }
      const f = el.getAttribute("data-sheets-formula");
      if (f) v = f;
      row[ci] = st ? { v: v.trim(), st } : { v: v.trim() };
      const rs = Number(el.getAttribute("rowspan") ?? 1);
      const cs = Number(el.getAttribute("colspan") ?? 1);
      for (let k = 0; k < cs; k++) {
        if (k) row[ci + k] = { v: "" };
        if (rs > 1) spans[ci + k] = ri + rs;
      }
      ci += cs;
    });
    cells.push(row.map((c) => c ?? { v: "" }));
  });
  if (!cells.length) return null;
  return { cells, source: table.getAttribute("data-oc") };
}

function styleFrom(css: string, el: HTMLElement): CellStyle | undefined {
  const s: CellStyle = {};
  const get = (p: string) => {
    const m = new RegExp(`(?:^|;)\\s*${p}\\s*:\\s*([^;]+)`, "i").exec(css);
    return m ? m[1].trim() : "";
  };
  const fw = get("font-weight");
  if (fw === "bold" || Number(fw) >= 600 || el.querySelector("b,strong")) s.b = true;
  if (get("font-style") === "italic" || el.querySelector("i,em")) s.i = true;
  if (/line-through/.test(get("text-decoration"))) s.st = true;
  const fg = get("color");
  if (fg && !/^(windowtext|black|#000000|#000|rgb\(0,\s*0,\s*0\))$/i.test(fg)) s.fg = fg;
  const bg = get("background-color") || get("background");
  if (bg && !/^(transparent|white|#ffffff|#fff|rgb\(255,\s*255,\s*255\)|none)$/i.test(bg)) s.bg = bg;
  const al = get("text-align");
  if (al === "center") s.al = "c";
  else if (al === "right") s.al = "r";
  const nf = get("mso-number-format").replace(/\\/g, "");
  if (/%/.test(nf)) s.nf = "pct";
  else if (/[$€£¥]/.test(nf)) s.nf = "cur";
  return Object.keys(s).length ? s : undefined;
}

/** Pasted text that Excel or Sheets shows formatted, back to a value a formula reads. */
export function pastedValue(v: string): { v: string; nf?: NumFmt } {
  const t = v.trim();
  if (!t || t.startsWith("=")) return { v: t };
  let m = /^(-?)[$€£¥]\s?([\d,]*\.?\d+)$/.exec(t) ?? /^(-?)([\d,]*\.?\d+)\s?[$€£¥]$/.exec(t);
  if (m && /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(m[2])) return { v: m[1] + m[2].replace(/,/g, ""), nf: "cur" };
  m = /^(-?[\d,]*\.?\d+)%$/.exec(t);
  if (m) return { v: String(Math.round((Number(m[1].replace(/,/g, "")) / 100) * 1e12) / 1e12), nf: "pct" };
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { v: t.replace(/,/g, "") };
  return { v: t };
}

/* ---------------------------------------------------------------- number formats */

/** Excel's day 0 (with its 1900 leap-year quirk folded in). */
const EPOCH = Date.UTC(1899, 11, 30);

export function serialToDate(n: number): Date {
  return new Date(EPOCH + Math.round(n * 86400000));
}

/** A typed date (2026-03-14, 14/3/2026 is left as text) as Excel's serial, else null. */
export function dateSerial(s: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.round((t - EPOCH) / 86400000);
}

/** The text a cell shows: the engine's value through the cell's number format. */
export function formatValue(v: string, st: CellStyle | undefined, locale?: string, currency = "EUR"): string {
  if (!st?.nf && st?.dp == null) return v;
  if (!isNumber(v)) return v;
  const n = Number(v);
  const dp = st.dp;
  const o = (min: number, max = min): Intl.NumberFormatOptions => ({ minimumFractionDigits: min, maximumFractionDigits: max });
  try {
    switch (st.nf) {
      case "pct":
        return new Intl.NumberFormat(locale, { style: "percent", ...o(dp ?? 0) }).format(n);
      case "cur":
        return new Intl.NumberFormat(locale, { style: "currency", currency, ...o(dp ?? 2) }).format(n);
      case "date":
        return new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(serialToDate(n));
      case "sci":
        return n.toExponential(dp ?? 2).toUpperCase();
      case "num":
        return new Intl.NumberFormat(locale, o(dp ?? 2)).format(n);
      default:
        return new Intl.NumberFormat(locale, { ...o(dp ?? 0), useGrouping: false }).format(n);
    }
  } catch {
    return v;
  }
}

/** Decimals shown now (for the decimals buttons). */
export function decimalsOf(v: string, st: CellStyle | undefined): number {
  if (st?.dp != null) return st.dp;
  if (st?.nf === "cur" || st?.nf === "num" || st?.nf === "sci") return 2;
  if (st?.nf === "pct") return 0;
  const m = /\.(\d+)/.exec(v);
  return m ? m[1].length : 0;
}

/** True for the codes the engine shows for an error. */
export const isError = (v: string) => /^#(REF!|DIV\/0!|NAME\?|VALUE!|N\/A|NUM!|NULL!|SPILL!|CALC!|CIRC!|ERROR!)/.test(v);

/** Sum, average and count of a selection's values (the status bar). */
export function aggregate(values: string[]): { sum: number; avg: number; count: number; nums: number } {
  let sum = 0;
  let nums = 0;
  let count = 0;
  for (const v of values) {
    if (v === "") continue;
    count++;
    if (isNumber(v)) (sum += Number(v), nums++);
  }
  return { sum, avg: nums ? sum / nums : 0, count, nums };
}

/* ---------------------------------------------------------------- layout */

/** Prefix offsets of sizes (rem): `off[i]` is where item `i` starts; `off[n]` the total. */
export function offsets(sizes: number[]): Float64Array {
  const o = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) o[i + 1] = o[i] + sizes[i];
  return o;
}

/** The first index whose span contains `x` (binary search over offsets). */
export function indexAt(off: Float64Array, x: number): number {
  let lo = 0;
  let hi = off.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (off[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
