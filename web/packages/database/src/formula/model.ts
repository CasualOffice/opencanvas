// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Formula, relation and rollup fields in the Y.Doc (ADR-078, docs/15 §4). Only definitions and
// relation row ids are stored; values come from the engine (./engine.ts).

import * as Y from "yjs";
import { databasesRoot, DB_ORIGIN, fieldsOf, fieldY, nid, readDb, rowsOf, tx } from "../model";
import type { CellValue, DbField, FieldType, RelDef, RollDef } from "../types";

/** Links to a deleted target database are kept this long (prototype 4a). */
export const GONE_DAYS = 30;

/** Turns a field into a formula, relation or rollup field: computed fields keep no cells. */
export function makeAdvanced(doc: Y.Doc, dbId: string, fid: string, type: FieldType, def: { formula?: string; rel?: RelDef; roll?: RollDef } = {}) {
  tx(doc, dbId, (m) => {
    const fy = fieldY(m, fid);
    if (!fy || fy.get("type") === "title") return;
    fy.set("type", type);
    fy.set("options", null);
    for (const k of ["formula", "rel", "roll"] as const) {
      if (def[k] != null) fy.set(k, typeof def[k] === "object" ? { ...(def[k] as object) } : def[k]);
      else fy.delete(k);
    }
    rowsOf(m).forEach((r) => r instanceof Y.Map && (type === "relation" ? r.set(fid, []) : r.delete(fid)));
  });
}

export function setFormula(doc: Y.Doc, dbId: string, fid: string, formula: string) {
  tx(doc, dbId, (m) => fieldY(m, fid)?.set("formula", formula));
}

export function setRollup(doc: Y.Doc, dbId: string, fid: string, roll: RollDef) {
  tx(doc, dbId, (m) => fieldY(m, fid)?.set("roll", { ...roll }));
}

/** Rewrites `prop("old")` in every formula of the database after a rename (engine-backed). */
export function renameInFormulas(doc: Y.Doc, dbId: string, rename: (src: string) => string) {
  tx(doc, dbId, (m) =>
    fieldsOf(m).forEach((f) => {
      const src = f.get("formula");
      if (typeof src === "string") {
        const next = rename(src);
        if (next !== src) f.set("formula", next);
      }
    }),
  );
}

/**
 * Adds a relation field to `dbId` pointing at `target` (same canvas). Two-way (the default on
 * one canvas, prototype 2a) also adds the reverse field in the target, in one transaction.
 */
export function addRelation(doc: Y.Doc, dbId: string, fid: string, target: string, opts: { two: boolean; backName?: string }) {
  doc.transact(() => {
    const src = databasesRoot(doc).get(dbId), dst = databasesRoot(doc).get(target);
    if (!(src instanceof Y.Map) || !(dst instanceof Y.Map)) return;
    let back: string | undefined;
    if (opts.two) {
      back = nid("f");
      const fy = new Y.Map<unknown>();
      fy.set("id", back);
      fy.set("name", opts.backName || String(src.get("name") || "Related"));
      fy.set("type", "relation");
      fy.set("options", null);
      fy.set("rel", { db: dbId, two: true, back: fid });
      fieldsOf(dst).push([fy]);
      rowsOf(dst).forEach((r) => r instanceof Y.Map && r.set(back!, []));
    }
    const fy = fieldY(src, fid);
    if (!fy) return;
    fy.set("type", "relation");
    fy.set("options", null);
    fy.delete("formula");
    fy.delete("roll");
    fy.set("rel", opts.two ? { db: target, two: true, back } : { db: target });
    rowsOf(src).forEach((r) => r instanceof Y.Map && r.set(fid, []));
  }, DB_ORIGIN);
}


const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Sets a relation cell. Two-way: the reverse cells in the target follow in the same
 * transaction (prototype 2c), so other clients see both sides at once.
 */
export function setRelation(doc: Y.Doc, dbId: string, rowId: string, f: DbField, next: string[]) {
  doc.transact(() => {
    const src = databasesRoot(doc).get(dbId);
    if (!(src instanceof Y.Map)) return;
    const row = rowsOf(src).get(rowId);
    if (!(row instanceof Y.Map)) return;
    const before = ids(row.get(f.id));
    row.set(f.id, next.slice());
    const rel = f.rel;
    if (!rel?.two || !rel.back || rel.file) return;
    const dst = databasesRoot(doc).get(rel.db);
    if (!(dst instanceof Y.Map)) return;
    const rows = rowsOf(dst);
    const touch = (tid: string, add: boolean) => {
      const tr = rows.get(tid);
      if (!(tr instanceof Y.Map)) return;
      const cur = ids(tr.get(rel.back!));
      const has = cur.includes(rowId);
      if (add && !has) tr.set(rel.back!, [...cur, rowId]);
      if (!add && has) tr.set(rel.back!, cur.filter((x) => x !== rowId));
    };
    for (const t of next) if (!before.includes(t)) touch(t, true);
    for (const t of before) if (!next.includes(t)) touch(t, false);
  }, DB_ORIGIN);
}

/** Deleting one side of a two-way relation keeps the other side as one-way (prototype 2c). */
export function unpairBack(doc: Y.Doc, f: DbField) {
  const rel = f.rel;
  if (!rel?.two || !rel.back || rel.file) return;
  tx(doc, rel.db, (m) => {
    const fy = fieldY(m, rel.back!);
    const r = fy?.get("rel");
    if (fy && r && typeof r === "object") fy.set("rel", { db: (r as RelDef).db });
  });
}

const dayNum = (iso: string) => Math.floor(Date.parse(iso + "T00:00:00Z") / 86_400_000);

/**
 * Same-canvas relations whose target database is gone (prototype 4a): `goneAt` is stamped the
 * first time, the ids are kept for 30 days so restoring the database brings the links back, and
 * cleared after. A target that is back loses its `goneAt`. Editors only; returns what changed.
 */
export function sweepGone(doc: Y.Doc, dbId: string, today: string): "none" | "marked" | "cleared" | "restored" {
  const m = databasesRoot(doc).get(dbId);
  if (!(m instanceof Y.Map)) return "none";
  let out: "none" | "marked" | "cleared" | "restored" = "none";
  const fields = readDb(dbId, m).fields.filter((f) => f.type === "relation" && f.rel && !f.rel.file);
  if (!fields.length) return out;
  tx(doc, dbId, (mm) => {
    for (const f of fields) {
      const rel = f.rel!;
      const fy = fieldY(mm, f.id);
      if (!fy) continue;
      const exists = databasesRoot(doc).get(rel.db) instanceof Y.Map;
      if (exists && rel.goneAt) {
        const { goneAt: _, ...rest } = rel;
        fy.set("rel", rest);
        out = "restored";
      } else if (!exists && !rel.goneAt) {
        fy.set("rel", { ...rel, goneAt: today });
        out = "marked";
      } else if (!exists && rel.goneAt && dayNum(today) - dayNum(rel.goneAt) > GONE_DAYS) {
        rowsOf(mm).forEach((r) => r instanceof Y.Map && r.set(f.id, []));
        out = "cleared";
      }
    }
  });
  return out;
}

/** Plain `{fields, rows}` of a database for the engine's `related`. */
export function engineDb(doc: Y.Doc, dbId: string): { fields: DbField[]; rows: { id: string; v: Record<string, CellValue> }[] } | null {
  const m = databasesRoot(doc).get(dbId);
  if (!(m instanceof Y.Map)) return null;
  const d = readDb(dbId, m);
  return { fields: d.fields, rows: d.rows };
}
