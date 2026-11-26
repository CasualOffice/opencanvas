// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Loading the WASM engine on demand and computing a database's formula and rollup values.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { databasesRoot, setFormulaRenamer } from "../model";
import { isoDate } from "../query";
import type { DbField, DbSnapshot } from "../types";
import { loadEngine, type ComputeOut, type Engine } from "./engine";
import { engineDb } from "./model";

export type EngineStatus = "idle" | "loading" | "ready" | "failed";

export interface EngineState {
  status: EngineStatus;
  engine: Engine | null;
  retry: () => void;
}

/** True when a database has fields the engine computes or resolves. */
export const needsEngine = (fields: DbField[]) => fields.some((f) => f.type === "formula" || f.type === "rollup" || f.type === "relation");

/** Loads the engine once `needed` turns true (the first formula, relation or rollup field). */
export function useEngine(needed: boolean): EngineState {
  const [st, setSt] = useState<{ status: EngineStatus; engine: Engine | null }>({ status: "idle", engine: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!needed || st.engine) return;
    let live = true;
    setSt({ status: "loading", engine: null });
    loadEngine().then(
      (engine) => {
        setFormulaRenamer(engine.rename);
        if (live) setSt({ status: "ready", engine });
      },
      () => live && setSt({ status: "failed", engine: null }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...st, retry };
}

/** Related databases' changes bump a counter so values follow them (DB-A3). */
function useRelatedVersion(doc: Y.Doc, ids: string[]): number {
  const [n, setN] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    if (!ids.length) return;
    const root = databasesRoot(doc);
    const bump = () => setN((x) => x + 1);
    const watched = new Set(ids);
    const onRoot = (e: Y.YMapEvent<Y.Map<unknown>>) => {
      for (const k of e.keysChanged) if (watched.has(k)) return bump();
    };
    const onDeep = (evs: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      for (const ev of evs) if (watched.has(String(ev.path[0] ?? ""))) return bump();
    };
    root.observe(onRoot);
    root.observeDeep(onDeep);
    return () => {
      root.unobserve(onRoot);
      root.unobserveDeep(onDeep);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key]);
  return n;
}

export interface Related {
  [key: string]: { fields: { id: string; name: string; type: string }[]; rows: { id: string; v: Record<string, unknown> }[] } | { noAccess: true };
}

/** `related` for the engine: same-canvas databases from the doc, others from live blocks. */
export function relatedOf(doc: Y.Doc, db: DbSnapshot, env: BlockEnv): Related {
  const out: Related = {};
  for (const f of db.fields) {
    if (f.type !== "relation" || !f.rel) continue;
    if (f.rel.file) {
      const key = `${f.rel.file}/${f.rel.db}`;
      const live = env.liveDb?.(f.rel.file, f.rel.db) ?? null;
      out[key] = live && live !== "noAccess" ? live : { noAccess: true };
    } else {
      const d = engineDb(doc, f.rel.db);
      if (d) out[f.rel.db] = d;
    }
  }
  return out;
}

/** Engine output for the database, recomputed when it or a related database changes. */
export function useComputed(doc: Y.Doc, db: DbSnapshot, env: BlockEnv, engine: Engine | null): ComputeOut | null {
  const relIds = useMemo(() => db.fields.filter((f) => f.type === "relation" && f.rel && !f.rel.file).map((f) => f.rel!.db), [db.fields]);
  const ver = useRelatedVersion(doc, relIds);
  return useMemo(() => {
    if (!engine || !needsEngine(db.fields)) return null;
    const people: Record<string, string> = {};
    for (const u of env.users) people[u.id] = u.name;
    try {
      return engine.compute({ today: isoDate(new Date()), fields: db.fields, rows: db.rows, related: relatedOf(doc, db, env), people });
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, db, ver, env.users]);
}
