// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Find and replace in a canvas (SRCH-01, ADR-066, docs/34 §4.2): client-side over the live
// document, so it sees every collaborator's latest text and costs the server nothing. Replace
// is ordinary editing, so the server's role filter applies as it does to typing.
//
// Where it looks, in document order: text blocks (never inside a mention chip, a date chip or
// a link's address), database cells and board text at the place their block sits, live blocks
// by their own editor's text when connected (else their snapshot, find only), and comments at
// the end when asked (find only: replace never rewrites someone's words). Matches in a live
// block are never replaced with the canvas: `replaceInLive` changes them in that block's own
// editor (its room), as one undo step there, after a separate confirmation (ADR-066).
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

export const MAX_MATCHES = 10_000;
/** Time budget of one pass over the canvas for a pattern (docs/34 §4.2). */
export const BUDGET_MS = 50;
/** Undo origin of replace writes outside the text (cells, board shapes). */
export const FIND_ORIGIN = { source: "@opencanvas/find" };

export interface Scope {
  text: boolean;
  cells: boolean;
  board: boolean;
  comments: boolean;
}
export interface Options {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  scope: Scope;
}
export const DEFAULT_OPTIONS: Options = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: { text: true, cells: true, board: true, comments: false },
};

interface Base {
  start: number;
  end: number;
  /** The matched text and, for patterns, its groups (for `$1` in the replacement). */
  groups: string[];
}
export type Match =
  | (Base & { kind: "text"; from: number; to: number })
  | (Base & { kind: "cell"; pos: number; dbId: string; dbName: string; rowId: string; fieldId: string; fieldName: string; editable: boolean; hidden: boolean })
  | (Base & { kind: "shape"; pos: number; boardId: string; shapeId: string; key: "text" | "label" })
  | (Base & {
      kind: "live";
      pos: number;
      title: string;
      fileId: string;
      /** In the live file's own editor (connected), else -1 (matched in the snapshot). */
      from: number;
      to: number;
      /** Connected and this person may edit the live file. */
      editable: boolean;
    })
  | (Base & { kind: "comment"; threadId: string; index: number });

export type Compiled = { ok: true; re: RegExp } | { ok: false; error: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The query as a global regular expression, or why it does not parse. */
export function compile(q: string, o: Pick<Options, "caseSensitive" | "wholeWord" | "regex">): Compiled {
  if (!q) return { ok: false, error: "" };
  let src = o.regex ? q : escapeRe(q);
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return { ok: true, re: new RegExp(src, "gu" + (o.caseSensitive ? "" : "i")) };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    // "Invalid regular expression: /(SSO|/gu: Unterminated group" -> "Unterminated group".
    return { ok: false, error: m.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, "") || "Invalid pattern" };
  }
}

export class TooSlow extends Error {}

/** Scans one string; `push` returns false once the cap is reached. */
function scan(re: RegExp, s: string, deadline: number, push: (start: number, end: number, groups: string[]) => boolean) {
  if (!s) return true;
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(s);
    if (!m) return true;
    if (performance.now() > deadline) throw new TooSlow();
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      if (re.lastIndex > s.length) return true;
      continue;
    }
    if (!push(m.index, m.index + m[0].length, Array.from(m, (g) => g ?? ""))) return false;
  }
}

/** Text of a textblock with a position per character; atoms read as U+FFFC so no match spans them. */
function textOf(node: PMNode, pos: number): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  node.forEach((child, offset) => {
    const p = pos + 1 + offset;
    if (child.isText) {
      const t = child.text ?? "";
      for (let i = 0; i < t.length; i++) at.push(p + i);
      s += t;
    } else {
      at.push(p);
      s += "￼";
    }
  });
  at.push(pos + 1 + node.content.size);
  return { s, at };
}

const CELL_TEXT = new Set(["title", "text", "url"]);
const str = (v: unknown) => (typeof v === "string" ? v : "");

interface Field {
  id: string;
  name: string;
  type: string;
  options: { v: string }[];
}
function fieldsOf(db: Y.Map<unknown>): Field[] {
  const raw = db.get("fields");
  const list = raw instanceof Y.Array ? raw.toArray() : Array.isArray(raw) ? raw : [];
  return list.map((f) => {
    const o = (f instanceof Y.Map ? f.toJSON() : f) as Record<string, unknown>;
    let options = o.options as unknown;
    if (typeof options === "string") {
      try {
        options = JSON.parse(options);
      } catch {
        options = [];
      }
    }
    return { id: str(o.id), name: str(o.name), type: str(o.type), options: Array.isArray(options) ? (options as { v: string }[]) : [] };
  });
}
function rowIds(db: Y.Map<unknown>): string[] {
  const order = db.get("order");
  if (order instanceof Y.Array) return order.toArray().map(String);
  const rows = db.get("rows");
  return rows instanceof Y.Map ? Array.from(rows.keys()) : [];
}
function hiddenFields(db: Y.Map<unknown>): Set<string> {
  const views = db.get("views");
  const view = str(db.get("view")) || "table";
  if (!(views instanceof Y.Map)) return new Set();
  let p = views.get(view) as unknown;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      p = null;
    }
  }
  const hidden = (p as { hidden?: unknown } | null)?.hidden;
  return new Set(Array.isArray(hidden) ? hidden.map(String) : []);
}
/** A cell as the reader sees it: option labels, people's names left as ids (find runs on text). */
function cellText(f: Field, v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : str((x as { v?: unknown })?.v))).join(", ");
  if (typeof v === "object") return str((v as { v?: unknown }).v);
  if (f.type === "checkbox") return "";
  return String(v);
}
function shapeOrder(board: Y.Map<unknown>): string[] {
  const shapes = board.get("shapes");
  const order = board.get("order");
  const ids = order instanceof Y.Array ? order.toArray().map(String) : [];
  if (shapes instanceof Y.Map) for (const k of shapes.keys()) if (!ids.includes(k)) ids.push(k);
  return ids;
}
/** Board text in reading order: top to bottom, then left to right (docs/34 frame 1e). */
function readingOrder(board: Y.Map<unknown>): { id: string; m: Y.Map<unknown> }[] {
  const shapes = board.get("shapes");
  if (!(shapes instanceof Y.Map)) return [];
  const list = shapeOrder(board)
    .map((id) => ({ id, m: shapes.get(id) }))
    .filter((x): x is { id: string; m: Y.Map<unknown> } => x.m instanceof Y.Map);
  const num = (m: Y.Map<unknown>, k: string) => (typeof m.get(k) === "number" ? (m.get(k) as number) : 0);
  return list.sort((a, b) => Math.round(num(a.m, "y") / 40) - Math.round(num(b.m, "y") / 40) || num(a.m, "x") - num(b.m, "x"));
}
function snapshotText(v: unknown): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === "string") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o.type === "text" && typeof o.text === "string") out.push(o.text);
      if (typeof o.markdown === "string") out.push(o.markdown);
      Object.values(o).forEach(walk);
    }
  };
  walk(v);
  return out.join(" ");
}

/** A connected live block: its own editor (bound to the live file's room). */
export interface LiveSource {
  editor: Editor;
  editable: boolean;
}

/** Text matches of `re` in the textblocks of `doc` (positions in `doc`). */
function scanText(doc: PMNode, re: RegExp, deadline: number, push: (from: number, to: number, start: number, end: number, groups: string[]) => boolean): boolean {
  let going = true;
  doc.descendants((node, pos) => {
    if (!going) return false;
    if (!node.isTextblock) return true;
    const { s, at } = textOf(node, pos);
    going = scan(re, s, deadline, (a, b, groups) => (s.slice(a, b).includes("￼") ? true : push(at[a], at[b - 1] + 1, a, b, groups)));
    return false;
  });
  return going;
}

export interface FindResult {
  matches: Match[];
  /** More than [`MAX_MATCHES`]: the count reads "10,000+". */
  capped: boolean;
}

/** Every match of `re` in the canvas, in document order. Throws [`TooSlow`] past the budget. */
export function findAll(doc: PMNode, ydoc: Y.Doc, re: RegExp, scope: Scope, budgetMs = BUDGET_MS, live?: (fileId: string) => LiveSource | null): FindResult {
  const deadline = performance.now() + budgetMs;
  const matches: Match[] = [];
  let capped = false;
  const push = (m: Match) => {
    if (matches.length >= MAX_MATCHES) {
      capped = true;
      return false;
    }
    matches.push(m);
    return true;
  };
  const dbs = ydoc.getMap("databases");
  const boards = ydoc.getMap("boards");
  let going = true;
  doc.descendants((node, pos) => {
    if (!going) return false;
    if (node.isTextblock) {
      if (!scope.text) return false;
      const { s, at } = textOf(node, pos);
      going = scan(re, s, deadline, (a, b, groups) => {
        if (s.slice(a, b).includes("￼")) return true;
        return push({ kind: "text", from: at[a], to: at[b - 1] + 1, start: a, end: b, groups });
      });
      return false;
    }
    const type = node.type.name;
    if (type === "database" && scope.cells) {
      const dbId = String(node.attrs.dbId ?? "");
      const db = dbs.get(dbId);
      if (db instanceof Y.Map) {
        const fields = fieldsOf(db);
        const hidden = hiddenFields(db);
        const rows = db.get("rows");
        for (const rowId of rowIds(db)) {
          const row = rows instanceof Y.Map ? rows.get(rowId) : null;
          if (!(row instanceof Y.Map)) continue;
          for (const f of fields) {
            const text = cellText(f, row.get(f.id));
            going = scan(re, text, deadline, (a, b, groups) =>
              push({ kind: "cell", pos, dbId, dbName: str(db.get("name")) || "Database", rowId, fieldId: f.id, fieldName: f.name, editable: CELL_TEXT.has(f.type), hidden: hidden.has(f.id), start: a, end: b, groups }),
            );
            if (!going) return false;
          }
        }
      }
      return false;
    }
    if (type === "board" && scope.board) {
      const boardId = String(node.attrs.boardId ?? "");
      const board = boards.get(boardId);
      if (board instanceof Y.Map) {
        for (const { id, m } of readingOrder(board)) {
          for (const key of ["text", "label"] as const) {
            going = scan(re, str(m.get(key)), deadline, (a, b, groups) => push({ kind: "shape", pos, boardId, shapeId: id, key, start: a, end: b, groups }));
            if (!going) return false;
          }
        }
      }
      return false;
    }
    if (type === "liveBlock" && scope.text) {
      const title = str(node.attrs.title);
      const fileId = str(node.attrs.fileId);
      const src = live?.(fileId);
      if (src && !src.editor.isDestroyed) {
        const editable = src.editable && src.editor.isEditable;
        going = scanText(src.editor.state.doc, re, deadline, (from, to, a, b, groups) => push({ kind: "live", pos, title, fileId, from, to, editable, start: from, end: from + (b - a), groups }));
      } else going = scan(re, snapshotText(node.attrs.snapshot), deadline, (a, b, groups) => push({ kind: "live", pos, title, fileId, from: -1, to: -1, editable: false, start: a, end: b, groups }));
      return false;
    }
    return true;
  });
  if (going && scope.comments) {
    const comments = ydoc.getMap("comments");
    const ids = Array.from(comments.keys()).sort();
    outer: for (const threadId of ids) {
      const t = comments.get(threadId);
      const msgs = t instanceof Y.Map ? t.get("messages") : null;
      const list = msgs instanceof Y.Array ? msgs.toArray() : [];
      for (let index = 0; index < list.length; index++) {
        const m = list[index];
        const text = str(m instanceof Y.Map ? m.get("text") : (m as { text?: unknown })?.text);
        if (!scan(re, text, deadline, (a, b, groups) => push({ kind: "comment", threadId, index, start: a, end: b, groups }))) break outer;
      }
    }
  }
  return { matches, capped };
}

/** The replacement for one match: `$&` and `$1`-`$9` for patterns, the text as is otherwise. */
export function expand(replacement: string, m: Match, regex: boolean): string {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|\d)/g, (_, c: string) => (c === "$" ? "$" : c === "&" ? m.groups[0] ?? "" : m.groups[Number(c)] ?? ""));
}

/** Whether replace may change this match. */
export const replaceable = (m: Match) => m.kind === "text" || m.kind === "shape" || (m.kind === "cell" && m.editable);

export interface ReplaceSummary {
  replaced: number;
  /** Read-only cells (options, people, numbers, dates): found, not changed. */
  skipped: number;
  /** Matches in live blocks: replaced in their own room, after a separate confirmation. */
  live: number;
}

/**
 * Replaces `targets` (every match, or the current one) as **one transaction and one undo
 * step**: the text in one ProseMirror transaction, cells and shapes in one Yjs transaction
 * with [`FIND_ORIGIN`], with the undo manager's capture boundary around both.
 */
export function replaceMatches(editor: Editor, ydoc: Y.Doc, targets: Match[], replacement: string, regex: boolean, um?: Y.UndoManager | null): ReplaceSummary {
  const sum: ReplaceSummary = { replaced: 0, skipped: 0, live: 0 };
  const text = targets.filter((m): m is Extract<Match, { kind: "text" }> => m.kind === "text");
  const other: Match[] = [];
  for (const m of targets) {
    if (m.kind === "live") sum.live++;
    else if (m.kind === "comment") continue;
    else if (m.kind === "cell" && !m.editable) sum.skipped++;
    else if (m.kind !== "text") other.push(m);
  }
  if (um) {
    um.addToScope([ydoc.getMap("boards"), ydoc.getMap("databases")]);
    um.trackedOrigins.add(FIND_ORIGIN);
    um.stopCapturing();
  }
  if (text.length) {
    const { state } = editor;
    const tr = state.tr;
    for (const m of [...text].sort((a, b) => b.from - a.from)) {
      const rep = expand(replacement, m, regex);
      const at = state.doc.nodeAt(m.from);
      if (rep) tr.replaceWith(m.from, m.to, state.schema.text(rep, at?.marks ?? []));
      else tr.delete(m.from, m.to);
      sum.replaced++;
    }
    editor.view.dispatch(tr);
  }
  if (other.length) {
    // Per string: replace from the end so earlier offsets stay valid.
    const groups = new Map<string, Match[]>();
    for (const m of other) {
      const k = m.kind === "cell" ? `c\u0000${m.dbId}\u0000${m.rowId}\u0000${m.fieldId}` : m.kind === "shape" ? `s\u0000${m.boardId}\u0000${m.shapeId}\u0000${m.key}` : "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(m);
    }
    ydoc.transact(() => {
      for (const [, ms] of groups) {
        const m0 = ms[0];
        let target: Y.Map<unknown> | null = null;
        let key = "";
        if (m0.kind === "cell") {
          const rows = (ydoc.getMap("databases").get(m0.dbId) as Y.Map<unknown> | undefined)?.get("rows");
          target = rows instanceof Y.Map ? ((rows.get(m0.rowId) as Y.Map<unknown>) ?? null) : null;
          key = m0.fieldId;
        } else if (m0.kind === "shape") {
          const shapes = (ydoc.getMap("boards").get(m0.boardId) as Y.Map<unknown> | undefined)?.get("shapes");
          target = shapes instanceof Y.Map ? ((shapes.get(m0.shapeId) as Y.Map<unknown>) ?? null) : null;
          key = m0.key;
        }
        const cur = target?.get(key);
        if (!target || typeof cur !== "string") continue;
        let s = cur;
        for (const m of [...ms].sort((a, b) => b.start - a.start)) {
          s = s.slice(0, m.start) + expand(replacement, m, regex) + s.slice(m.end);
          sum.replaced++;
        }
        target.set(key, s);
      }
    }, FIND_ORIGIN);
  }
  um?.stopCapturing();
  return sum;
}

export type LiveMatch = Extract<Match, { kind: "live" }>;

/** The live blocks whose matches may be replaced (connected, edit there), one per live file. */
export function liveGroups(matches: Match[]): { fileId: string; title: string; matches: LiveMatch[] }[] {
  const out = new Map<string, { fileId: string; title: string; matches: LiveMatch[] }>();
  for (const m of matches) {
    if (m.kind !== "live" || !m.editable || m.from < 0) continue;
    let g = out.get(m.fileId);
    if (!g) out.set(m.fileId, (g = { fileId: m.fileId, title: m.title, matches: [] }));
    // The same live file shown twice on the page: its text once.
    if (!g.matches.some((x) => x.from === m.from)) g.matches.push(m);
  }
  return [...out.values()];
}

/** Replaces `targets` (matches in one live file) in that file's own editor, as one
 *  transaction and one undo step in its room. Nothing when it is view only. */
export function replaceInLive(src: LiveSource, targets: LiveMatch[], replacement: string, regex: boolean): number {
  const e = src.editor;
  if (!src.editable || e.isDestroyed || !e.isEditable) return 0;
  const text = targets
    .filter((m) => m.editable && m.from >= 0)
    .map((m): Match => ({ kind: "text", from: m.from, to: m.to, start: m.start, end: m.end, groups: m.groups }));
  if (!text.length) return 0;
  const um = (yUndoPluginKey.getState(e.state) as { undoManager?: Y.UndoManager } | undefined)?.undoManager ?? null;
  return replaceMatches(e, (um?.doc as Y.Doc | undefined) ?? new Y.Doc(), text, replacement, regex, um).replaced;
}

/** "3 of 12", "10,000+", "No results". */
export function counter(current: number, total: number, capped: boolean): string {
  if (!total) return "No results";
  const n = capped ? `${MAX_MATCHES.toLocaleString("en-US")}+` : total.toLocaleString("en-US");
  return current >= 0 ? `${(current + 1).toLocaleString("en-US")} of ${n}` : n;
}

/** Stable identity of a match across recomputes (to keep the current one while others type). */
export function matchKey(m: Match): string {
  switch (m.kind) {
    case "text":
      return `t:${m.from}`;
    case "cell":
      return `c:${m.dbId}:${m.rowId}:${m.fieldId}:${m.start}`;
    case "shape":
      return `s:${m.boardId}:${m.shapeId}:${m.key}:${m.start}`;
    case "live":
      return `l:${m.pos}:${m.fileId}:${m.start}`;
    case "comment":
      return `m:${m.threadId}:${m.index}:${m.start}`;
  }
}

/** Where a match sits in document order (comments last). */
export function orderOf(m: Match): number {
  return m.kind === "text" ? m.from : m.kind === "comment" ? Number.MAX_SAFE_INTEGER : m.pos;
}

/** The index to show after a recompute: the same match if it still exists, else the next one. */
export function keepCurrent(prev: Match | null, next: Match[]): number {
  if (!next.length) return -1;
  if (!prev) return 0;
  const k = matchKey(prev);
  const same = next.findIndex((m) => matchKey(m) === k);
  if (same >= 0) return same;
  const o = orderOf(prev);
  const after = next.findIndex((m) => orderOf(m) >= o);
  return after >= 0 ? after : 0;
}

/** The line under the counter for a match outside plain text. */
export function where(m: Match | null): string | null {
  if (!m) return null;
  if (m.kind === "cell") return m.hidden ? `In a hidden column: ${m.fieldName}` : `In ${m.dbName} · column ${m.fieldName}`;
  if (m.kind === "shape") return "On a board";
  if (m.kind === "live") return `In live block ${m.title || "Untitled"} · ${m.editable ? "replace changes it everywhere it is shown" : m.from < 0 ? "find only until it connects" : "view only"}`;
  if (m.kind === "comment") return "In a comment · find only";
  return null;
}
