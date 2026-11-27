// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-06 (frames 4h, 8a): blocks placed after a spreadsheet or database. Loaded on demand
// (App's BlockEnv.sheetActions / dbActions import this module when a menu entry runs).
import type { Editor, JSONContent } from "@tiptap/core";
import type * as Y from "yjs";
import type { OcUser, SheetRange } from "@opencanvas/ui";
import type { LinkedDb } from "@opencanvas/sheet";
import { loadDatabase, loadSheet } from "../blockdata";

/** Inserts `node` right after the first `type` node whose `attr` is `id` (else at the end). */
function placeAfter(editor: Editor, type: string, attr: string, id: string, node: JSONContent) {
  let pos = -1;
  editor.state.doc.descendants((n, p) => {
    if (pos >= 0) return false;
    if (n.type.name === type && n.attrs[attr] === id) {
      pos = p + n.nodeSize;
      return false;
    }
    return true;
  });
  editor.chain().insertContentAt(pos >= 0 ? pos : editor.state.doc.content.size, node).run();
}

export const chartFromRange = (editor: Editor, r: SheetRange) => placeAfter(editor, "spreadsheet", "sheetId", r.sheetId, { type: "chart", attrs: { kind: "bar", src: "sheet", ...r } });

export const chartFromDb = (editor: Editor, dbId: string) => placeAfter(editor, "database", "dbId", dbId, { type: "chart", attrs: { kind: "bar", src: "db", dbId, agg: "count" } });

const csvCell = (t: string) => (/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

/** A sheet range (first row = field names) as a new database after the spreadsheet. */
export async function rangeToDatabase(editor: Editor, doc: Y.Doc, r: SheetRange, values: string[][], name: string) {
  const d = await loadDatabase();
  const rows = values.filter((row) => row.some((t) => t.trim()));
  if (rows.length < 1) return;
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const id = d.importCsvToDatabase(doc, rows.length === 1 ? csv + "\n" + rows[0].map(() => "").join(",") : csv, name);
  placeAfter(editor, "spreadsheet", "sheetId", r.sheetId, { type: "database", attrs: { dbId: id } });
}

/** Fields a live view can hold as text (computed and relation fields are left out). */
const NOT_LINKED = new Set(["formula", "rollup", "relation"]);

/** A database as the spreadsheet link reads it (cells as text, as the table shows them). */
export async function linkedSnapshot(dbDoc: Y.Doc, dbId: string, users: OcUser[]): Promise<(LinkedDb & { name: string }) | null> {
  const d = await loadDatabase();
  const m = d.getDbMap(dbDoc, dbId);
  if (!m) return null;
  const db = d.readDb(dbId, m);
  const fields = db.fields.filter((f) => !NOT_LINKED.has(f.type));
  return {
    name: db.name,
    fields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
    rows: db.rows.map((row) => ({ id: row.id, cells: fields.map((f) => d.cellToText(f, row.v[f.id], users)) })),
  };
}

/** 8a: a live view of the database, or a copy of its values, placed after it. */
export async function openAsSheet(editor: Editor, dbDoc: Y.Doc, doc: Y.Doc, dbId: string, mode: "view" | "convert", users: OcUser[]) {
  const [s, snap] = await Promise.all([loadSheet(), linkedSnapshot(dbDoc, dbId, users)]);
  if (!snap) return;
  const name = snap.name || "Database";
  const block =
    mode === "view"
      ? s.createSheetFrom(doc, name, [], { db: dbId, snap })
      : s.createSheetFrom(doc, name, [snap.fields.map((f) => f.name), ...snap.rows.map((r) => r.cells)]);
  placeAfter(editor, "database", "dbId", dbId, { type: "spreadsheet", attrs: { sheetId: block } });
}
