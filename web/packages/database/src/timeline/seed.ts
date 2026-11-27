// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Demo and templates (DB5-01): gives a database Start, Estimate and "Blocked by" so its Timeline
// and Workload views have something to show. The end date is an existing date field (Due).

import type * as Y from "yjs";
import { addField, getDbMap, readDb, setCell, setPrefs, setView, tx } from "../model";
import { addRelation, setRelation } from "../formula/model";
import type { ViewKind } from "../types";
import { addDays, day, iso } from "./logic";

/**
 * `deps` are `[blocked row index, blocker row index]`; `lengths` are working days per row (the
 * start is the due date minus them). The block opens on `view` (default the Timeline).
 */
export function seedTimeline(doc: Y.Doc, dbId: string, opts: { lengths: number[]; hours?: number[]; deps?: [number, number][]; view?: ViewKind }) {
  const m = getDbMap(doc, dbId);
  if (!m) return;
  const db0 = readDb(dbId, m);
  const due = db0.fields.find((f) => f.type === "date");
  if (!due) return;
  const start = addField(doc, dbId, "date", "Start");
  const est = addField(doc, dbId, "number", "Estimate (hours)");
  const dep = addField(doc, dbId, "text", "Blocked by");
  addRelation(doc, dbId, dep, dbId, { two: true, backName: "Blocks" });
  const db = readDb(dbId, getDbMap(doc, dbId)!);
  const depF = db.fields.find((f) => f.id === dep)!;
  tx(doc, dbId, () => {
    db.rows.forEach((r, i) => {
      const e = day(r.v[due.id]);
      if (e == null) return;
      setCell(doc, dbId, r.id, start, iso(addDays(e, -Math.max(0, (opts.lengths[i] ?? 3) - 1), true)));
      if (opts.hours?.[i] != null) setCell(doc, dbId, r.id, est, opts.hours[i]);
    });
  });
  const by = new Map<number, number[]>();
  for (const [a, b] of opts.deps ?? []) by.set(a, [...(by.get(a) ?? []), b]);
  for (const [a, bs] of by) {
    const row = db.rows[a];
    if (row) setRelation(doc, dbId, row.id, depF, bs.map((b) => db.rows[b]?.id).filter((x): x is string => !!x));
  }
  setPrefs(doc, dbId, "timeline", { tl: { start, end: due.id, dep, est, crit: true } });
  setPrefs(doc, dbId, "workload", { tl: { est } });
  setView(doc, dbId, opts.view ?? "timeline");
}
