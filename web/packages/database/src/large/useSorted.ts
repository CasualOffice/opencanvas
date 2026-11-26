// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Sorting a large view in a worker (prototype 1c): the old order stays usable (mapped onto the
// current rows) until the new one is ready; nothing shows under 300 ms, then a chip with the
// percent and a thin bar.

import { useEffect, useMemo, useRef, useState } from "react";
import type { OcUser } from "@opencanvas/ui";
import { cellToText } from "../model";
import type { DbField, DbRow, SortRule } from "../types";
import { sortOrder, type KeyCol, type SortJob } from "./sortcore";

/** Nothing is shown for sorts faster than this (small tables never flicker). */
export const BUSY_AFTER_MS = 300;

const NUMERIC = new Set(["number", "progress", "formula", "rollup"]);

export function keyColumn(rows: DbRow[], f: DbField, users: OcUser[]): KeyCol {
  const n = rows.length;
  if (NUMERIC.has(f.type) && rows.every((r) => r.v[f.id] == null || typeof r.v[f.id] === "number" || typeof r.v[f.id] === "object")) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = rows[i].v[f.id];
      col[i] = typeof v === "number" ? v : NaN;
    }
    return col;
  }
  if (f.type === "checkbox") {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = rows[i].v[f.id] ? 1 : 0;
    return col;
  }
  const opts = f.options?.map((o) => o.v);
  const col: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = rows[i].v[f.id];
    // Options sort in their defined order (Not started < In progress < Done), like the board.
    if (opts && typeof v === "string" && opts.includes(v)) col[i] = String.fromCharCode(0x21 + opts.indexOf(v));
    else col[i] = cellToText(f, v as never, users).toLowerCase();
  }
  return col;
}

let worker: Worker | null | undefined;
let seq = 0;
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === "undefined" ? null : new Worker(new URL("./sort.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  return worker;
}

export interface SortBusy {
  label: string;
  pct: number;
}

export function useSorted(rows: DbRow[], fields: DbField[], sorts: SortRule[], users: OcUser[]): { rows: DbRow[]; busy: SortBusy | null } {
  const active = sorts.map((s) => ({ s, f: fields.find((x) => x.id === s.f) })).filter((x): x is { s: SortRule; f: DbField } => !!x.f);
  const sig = active.map((x) => x.s.f + x.s.dir).join(",");
  const [state, setState] = useState<{ ids: string[] | null; sig: string }>({ ids: null, sig: "" });
  const [busy, setBusy] = useState<SortBusy | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (!active.length) return setState({ ids: null, sig: "" });
    const job: SortJob = { keys: active.map((x) => keyColumn(rows, x.f, users)), dirs: active.map((x) => x.s.dir), n: rows.length };
    const id = ++seq;
    latest.current = id;
    const label = `Sorting by ${active[0].f.name}`;
    const t0 = performance.now();
    let pct = 0;
    const show = setTimeout(() => latest.current === id && setBusy({ label, pct }), BUSY_AFTER_MS);
    const done = (order: Int32Array) => {
      clearTimeout(show);
      if (latest.current !== id) return;
      const ids = new Array<string>(order.length);
      for (let i = 0; i < order.length; i++) ids[i] = rows[order[i]].id;
      setState({ ids, sig });
      setBusy(null);
    };
    const w = getWorker();
    if (!w) {
      done(sortOrder(job));
      return () => clearTimeout(show);
    }
    const onMsg = (e: MessageEvent<{ id: number; p?: number; order?: Int32Array }>) => {
      if (e.data.id !== id) return;
      if (e.data.order) {
        w.removeEventListener("message", onMsg);
        done(e.data.order);
      } else if (e.data.p != null) {
        pct = Math.round(e.data.p * 100);
        if (performance.now() - t0 >= BUSY_AFTER_MS) setBusy({ label, pct });
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, ...job });
    return () => {
      clearTimeout(show);
      w.removeEventListener("message", onMsg);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sig, users]);
  const out = useMemo(() => {
    if (!active.length || !state.ids) return rows;
    // The last finished order, mapped onto the current rows; new rows go at the end.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const res: DbRow[] = [];
    for (const id of state.ids) {
      const r = byId.get(id);
      if (r) res.push(r), seen.add(id);
    }
    if (res.length !== rows.length) for (const r of rows) if (!seen.has(r.id)) res.push(r);
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state, sig]);
  return { rows: out, busy };
}
