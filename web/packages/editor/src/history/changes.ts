// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The server's structural diff (ADR-052, docs/30 §6.1 "As built") as the editor uses it: the
// list of changes the preview steps through (frames 4a-4c, 9c) and inline runs mapped onto the
// newer text. Pure: no DOM, no editor.

export type Run = [string, string];
export interface BlockEntry {
  op: "added" | "removed" | "changed" | "moved";
  path: string;
  blockId?: string;
  type?: string;
  changes?: string[];
  text?: Run[];
  attrs?: Record<string, { old: unknown; new: unknown }>;
  from?: string;
  node?: { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  after?: { path: string; blockId?: string } | null;
}
export interface DbEntry {
  dbId: string;
  op: "added" | "removed" | "changed";
  name?: string;
  fields?: { op: string; fieldId: string; name?: string; changes?: string[]; old?: unknown; new?: unknown }[];
  rows?: { op: "added" | "removed"; rowId: string; title?: string }[];
  cells?: { rowId: string; fieldId: string; field?: string; old: unknown; new: unknown }[];
  notes?: { rowId: string; text?: Run[] }[];
  order?: unknown;
  views?: unknown;
}
export interface ShapeEntry {
  op: "changed" | "moved" | "removed" | "added";
  shapeId: string;
  type?: string;
  changes?: string[];
  from?: number[];
  to?: number[];
  text?: Run[];
  style?: string[];
  shape?: { x?: number; y?: number; w?: number; h?: number; text?: string; type?: string };
}
export interface BoardEntry {
  boardId: string;
  op: "added" | "removed" | "changed";
  shapes?: ShapeEntry[];
  order?: unknown;
}
export interface Diff {
  summary: { added: number; removed: number; changed: number; moved: number };
  meta?: { field: string; old: unknown; new: unknown }[];
  blocks: BlockEntry[];
  databases: DbEntry[];
  boards: BoardEntry[];
  truncated?: boolean;
}

export type Kind = "add" | "rem" | "chg" | "move";
export type Target =
  | { t: "meta"; field: string }
  | { t: "block"; blockId?: string; path: string }
  | { t: "removed"; key: string }
  | { t: "db"; dbId: string }
  | { t: "row"; dbId: string; rowId: string }
  | { t: "field"; dbId: string; fieldId: string }
  | { t: "shape"; boardId: string; shapeId: string };

export interface Change {
  kind: Kind;
  title: string;
  detail: string;
  target: Target;
}

export interface Lookups {
  /** The newer side's text of a block, by id or path. */
  blockText(b: { blockId?: string; path: string }): string;
  rowTitle?(dbId: string, rowId: string): string;
  shapeText?(boardId: string, shapeId: string): string;
}

const OP: Record<string, Kind> = { added: "add", removed: "rem", changed: "chg", moved: "move" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** At most `n` characters, cut at a word with an ellipsis. */
export function clip(s: string, n = 48): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

/** The plain text of a removed block (`node` is ProseMirror-shaped JSON). */
export function nodeText(n: unknown): string {
  if (!n || typeof n !== "object") return "";
  const o = n as { text?: unknown; content?: unknown[] };
  if (typeof o.text === "string") return o.text;
  return (o.content ?? []).map(nodeText).join(o.content && (o.content as { type?: string }[]).some((c) => c && typeof c === "object" && !("text" in c)) ? " " : "");
}

/** "SAML → SSO, 100,000 → 50,000": removed and added words side by side. */
export function wordPairs(runs: Run[]): string {
  const out: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const [op, s] = runs[i];
    if (op === "del" && runs[i + 1]?.[0] === "ins") {
      out.push(`${s.trim()} → ${runs[i + 1][1].trim()}`);
      i++;
    } else if (op === "del") out.push(`− ${s.trim()}`);
    else if (op === "ins") out.push(`+ ${s.trim()}`);
  }
  return clip(out.join(", "), 60);
}

/**
 * Offsets of the runs in the newer text: added ranges and removed text with the offset it sat
 * at. Null when the runs no longer spell the block's text (then only the block is marked).
 */
export function mapRuns(text: string, runs: Run[]): { ins: [number, number][]; del: { at: number; text: string }[] } | null {
  const ins: [number, number][] = [];
  const del: { at: number; text: string }[] = [];
  let at = 0;
  let spelled = "";
  for (const [op, s] of runs) {
    if (op === "del") {
      del.push({ at, text: s });
      continue;
    }
    if (op === "ins") ins.push([at, at + s.length]);
    spelled += s;
    at += s.length;
  }
  return spelled === text ? { ins, del } : null;
}

const SHAPE_CHANGE: Record<string, string> = { moved: "moved", resized: "resized", text: "text", style: "style", rebound: "reconnected" };

function blockDetail(b: BlockEntry): string {
  if (b.op === "added") return "Added";
  if (b.op === "removed") return "Removed";
  if (b.op === "moved" && !(b.changes ?? []).some((c) => c !== "context")) return "Moved";
  const ch = b.changes ?? [];
  if (ch.includes("text") && b.text) return wordPairs(b.text);
  if (ch.includes("formatting")) return "Formatting";
  if (ch.includes("attrs") && b.attrs) {
    const k = Object.keys(b.attrs)[0] ?? "";
    if (k.endsWith("checked")) return b.attrs[k].new ? "Checked" : "Unchecked";
    return "Settings";
  }
  if (ch.includes("type")) return "Block type";
  return b.op === "moved" ? "Moved" : "Changed";
}

export function changeList(d: Diff, look: Lookups): Change[] {
  const out: Change[] = [];
  for (const m of d.meta ?? []) out.push({ kind: "chg", title: cap(m.field), detail: `${String(m.old ?? "")} → ${String(m.new ?? "")}`, target: { t: "meta", field: m.field } });
  for (const b of d.blocks ?? []) {
    const text = b.op === "removed" ? nodeText(b.node) : look.blockText(b);
    const fallback = cap((b.type ?? "block").replace(/([A-Z])/g, " $1").toLowerCase());
    out.push({
      kind: OP[b.op] ?? "chg",
      title: clip(text || fallback),
      detail: blockDetail(b),
      target: b.op === "removed" ? { t: "removed", key: b.blockId ?? b.path } : { t: "block", blockId: b.blockId, path: b.path },
    });
  }
  for (const db of d.databases ?? []) {
    // A database added or removed as a whole is a block change already.
    if (db.op !== "changed") continue;
    const name = db.name || "Database";
    for (const f of db.fields ?? []) {
      const renamed = f.changes?.includes("renamed");
      out.push({
        kind: OP[f.op] ?? "chg",
        title: `${name}: ${f.name ?? f.fieldId}`,
        detail: f.op === "added" ? "Field added" : f.op === "removed" ? "Field removed" : renamed ? `Renamed from ${String(f.old ?? "")}` : cap((f.changes ?? ["changed"]).join(", ")),
        target: { t: "field", dbId: db.dbId, fieldId: f.fieldId },
      });
    }
    for (const r of db.rows ?? []) out.push({ kind: OP[r.op], title: `${name}: ${r.title || "Untitled"}`, detail: r.op === "added" ? "Row added" : "Row removed", target: r.op === "removed" ? { t: "removed", key: `${db.dbId}:${r.rowId}` } : { t: "row", dbId: db.dbId, rowId: r.rowId } });
    const byRow = new Map<string, string[]>();
    for (const c of db.cells ?? []) byRow.set(c.rowId, [...(byRow.get(c.rowId) ?? []), c.field ?? c.fieldId]);
    for (const [rowId, fields] of byRow) out.push({ kind: "chg", title: `${name}: ${look.rowTitle?.(db.dbId, rowId) || "Row"}`, detail: fields.join(", "), target: { t: "row", dbId: db.dbId, rowId } });
    for (const n of db.notes ?? []) out.push({ kind: "chg", title: `${name}: ${look.rowTitle?.(db.dbId, n.rowId) || "Row"}`, detail: "Notes", target: { t: "row", dbId: db.dbId, rowId: n.rowId } });
    if (db.order) out.push({ kind: "chg", title: name, detail: "Row order", target: { t: "db", dbId: db.dbId } });
    if (db.views) out.push({ kind: "chg", title: name, detail: "View settings", target: { t: "db", dbId: db.dbId } });
  }
  for (const bd of d.boards ?? []) {
    if (bd.op !== "changed") continue;
    for (const s of bd.shapes ?? []) {
      const text = s.op === "removed" ? s.shape?.text ?? "" : look.shapeText?.(bd.boardId, s.shapeId) ?? "";
      const kind: Kind = s.op === "moved" ? "move" : OP[s.op];
      const detail = s.op === "added" ? "Added" : s.op === "removed" ? "Removed" : s.op === "moved" ? "Moved" : cap((s.changes ?? []).map((c) => SHAPE_CHANGE[c] ?? c).join(", ") || "changed");
      out.push({
        kind,
        title: `Board: ${clip(text) || cap(s.type ?? "shape")}`,
        detail,
        target: s.op === "removed" ? { t: "removed", key: `${bd.boardId}:${s.shapeId}` } : { t: "shape", boardId: bd.boardId, shapeId: s.shapeId },
      });
    }
  }
  return out;
}

/** A cell value as text, for the struck "was" value of a changed cell. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (Array.isArray(v)) return v.map(cellText).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
