// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import type { OcUser, Tone } from "@opencanvas/ui";
import type { DbField, DbOption, FieldType } from "./types";

/**
 * Parse CSV or TSV text into rows of cells.
 * - RFC 4180 quoting: `"a, b"`, escaped quotes `""`, newlines inside quotes.
 * - LF, CRLF and lone CR line endings.
 * - Delimiter: tab when the header line (outside quotes) has tabs and no commas, else comma.
 * - A leading BOM is dropped. Rows whose cells are all blank are dropped.
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  let any = false; // the current row has started
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
      continue;
    }
    if (c === '"' && cur === "") {
      q = true;
      any = true;
    } else if (c === d) {
      row.push(cur);
      cur = "";
      any = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any || cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function detectDelimiter(text: string): string {
  let tabs = 0;
  let commas = 0;
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    else if (!q && (c === "\n" || c === "\r")) break;
    else if (!q && c === "\t") tabs++;
    else if (!q && c === ",") commas++;
  }
  return tabs > 0 && commas === 0 ? "\t" : tabs > commas ? "\t" : ",";
}

/**
 * Quote one CSV cell when needed. A cell starting with `=`, `+`, `-`, `@`, tab or CR (and not
 * a plain number) gets a leading `'` so spreadsheets open it as text, never as a formula
 * (CSV injection, OWASP; docs/18 SEC-19).
 */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !NUM.test(s)) s = "'" + s;
  return /[",\r\n\t]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

const NUM = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/;
const PCT = /^[-+]?\d+(\.\d+)?%$/;
const BOOL = /^(true|false|yes|no|y|n|x|✓)$/i;
const DATE = /^\d{4}[-/]\d{2}[-/]\d{2}$/;
const URLRE = /^https?:\/\/\S+$/i;

/** Detect the field type of one column from its raw values (header excluded). */
export function detectType(values: string[], header = ""): FieldType {
  const v = values.map((x) => x.trim()).filter((x) => x !== "");
  if (!v.length) return "text";
  if (v.every((x) => PCT.test(x))) {
    const ok = v.every((x) => {
      const n = parseFloat(x);
      return n >= 0 && n <= 100;
    });
    return ok ? "progress" : "number";
  }
  if (v.every((x) => NUM.test(x) && /\d/.test(x))) return "number";
  if (v.every((x) => BOOL.test(x)) && v.some((x) => !/^x$/i.test(x))) return "checkbox";
  if (v.every((x) => DATE.test(x) && !isNaN(Date.parse(x.replace(/\//g, "-"))))) return "date";
  if (v.every((x) => URLRE.test(x))) return "url";
  if (v.some((x) => x.includes(";"))) {
    const items = new Set(v.flatMap(splitTags));
    if (items.size <= 16 && [...items].every((t) => t.length <= 40)) return "tags";
  }
  const uniq = new Set(v);
  if (uniq.size <= 8 && v.length >= 3 && uniq.size < v.length && [...uniq].every((t) => t.length <= 40)) {
    return /status|stage|state|phase/i.test(header) ? "status" : "select";
  }
  return "text";
}

export function splitTags(s: string): string[] {
  return s
    .split(/\s*;\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const COL: Tone[] = ["blue", "purple", "amber", "green", "pink", "gray"];
export function toneFor(v: string, j: number): Tone {
  if (/^(done|shipped|won|closed|complete(d)?|finished|published|hired|yes)$/i.test(v)) return "green";
  if (/progress|doing|building|fixing|reading/i.test(v)) return "blue";
  if (/block|critical|lost|negative|off track/i.test(v)) return "red";
  if (/not started|backlog|to ?do|idea|triage|^none$/i.test(v)) return "gray";
  return COL[j % COL.length];
}

export function matchUser(name: string, users: OcUser[]): OcUser | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return users.find((u) => u.name.toLowerCase() === n || u.id.toLowerCase() === n);
}

/** Detect fields for a parsed CSV (row 0 is the header). First column is always the title. */
export function detectFields(parsed: string[][], users: OcUser[] = []): DbField[] {
  const hdr = parsed[0] ?? [];
  const data = parsed.slice(1);
  const width = Math.max(hdr.length, ...data.map((r) => r.length), 0);
  const used = new Set<string>();
  const fields: DbField[] = [];
  for (let i = 0; i < width; i++) {
    const name = (hdr[i] ?? "").trim() || "Field " + (i + 1);
    let id = "c" + i;
    while (used.has(id)) id += "_";
    used.add(id);
    const col = data.map((r) => (r[i] ?? "").trim());
    let type: FieldType = i === 0 ? "title" : detectType(col, name);
    if ((type === "text" || type === "select") && users.length && col.some(Boolean) && col.every((x) => !x || matchUser(x, users))) type = "person";
    let options: DbOption[] | undefined;
    if (type === "status" || type === "select") {
      options = [...new Set(col.filter(Boolean))].map((v, j) => ({ v, c: toneFor(v, j) }));
    } else if (type === "tags") {
      options = [...new Set(col.flatMap(splitTags))].map((v, j) => ({ v, c: COL[j % COL.length] }));
    }
    fields.push(options ? { id, name, type, options } : { id, name, type });
  }
  return fields;
}

/** Convert one raw CSV string into a typed cell value for a field. */
export function coerce(raw: string, type: FieldType, users: OcUser[] = []): string | number | boolean | string[] | null {
  const x = (raw ?? "").trim();
  switch (type) {
    case "number": {
      if (!x) return null;
      const n = Number(x.replace(/[,%\s]/g, ""));
      return isNaN(n) ? null : n;
    }
    case "progress": {
      if (!x) return null;
      const n = parseFloat(x);
      return isNaN(n) ? null : Math.max(0, Math.min(100, n));
    }
    case "checkbox":
      return /^(true|yes|y|x|✓|1)$/i.test(x);
    case "tags":
      return splitTags(x);
    case "date":
      return x ? x.replace(/\//g, "-") : null;
    case "person":
      return x ? (matchUser(x, users)?.id ?? null) : null;
    default:
      return x || null;
  }
}
