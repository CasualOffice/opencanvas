// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DB100K (DB4-07): a cell edit re-reads that row, not the whole database; the incremental
// snapshot always equals a full read.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "./index";
import { addField, addRow, createDatabase, deleteRow, getDbMap, readDb, renameField, setCell } from "./model";
import { currentSnapshot, newSnapCache, noteChange } from "./snapshot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env: BlockEnv = { role: "edit", compact: false, me: { id: "p", name: "P", color: "#2a5ad7" }, users: [], toast: () => {} };

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function big(n: number) {
  const doc = new Y.Doc();
  const id = createDatabase(doc, "blank");
  const f = addField(doc, id, "number", "N");
  doc.transact(() => {
    for (let i = 0; i < n; i++) addRow(doc, id, { title: "Row " + i, [f]: i });
  });
  return { doc, id, f };
}

/** A seeded generator so failures repeat. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("database snapshot", () => {
  it("a cell edit in a 3,000-row database re-reads one row, not all of them", async () => {
    const { doc, id, f } = big(3000);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => root.render(<DatabaseBlock doc={doc} dbId={id} env={env} />));
    cleanup = () => act(() => root.unmount());
    const rid = readDb(id, getDbMap(doc, id)!).rows[10].id;
    const spy = vi.spyOn(Y.Map.prototype, "toJSON");
    await act(async () => setCell(doc, id, rid, f, 12345));
    expect(spy.mock.calls.length).toBeLessThan(20);
    expect(el.textContent).toContain("12,345");
  });

  it("stays equal to a full read through cell edits, new and deleted rows and field changes", () => {
    const { doc, id, f } = big(200);
    const m = getDbMap(doc, id)!;
    const c = newSnapCache();
    m.observeDeep((evs) => noteChange(c, evs));
    const next = rng(7);
    const pick = <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)];
    currentSnapshot(c, id, m);
    for (let step = 0; step < 300; step++) {
      const rows = readDb(id, m).rows;
      const op = next();
      if (op < 0.6) setCell(doc, id, pick(rows).id, f, Math.round(next() * 1000));
      else if (op < 0.7) doc.transact(() => {
        for (let k = 0; k < 5; k++) setCell(doc, id, pick(rows).id, f, -k);
      });
      else if (op < 0.8) addRow(doc, id, { [f]: step }, pick(rows).id);
      else if (op < 0.9 && rows.length > 50) deleteRow(doc, id, pick(rows).id);
      else renameField(doc, id, f, "N" + step);
      // Read on some steps only, so several changes pile up between snapshots.
      if (next() < 0.5) expect(JSON.stringify(currentSnapshot(c, id, m))).toBe(JSON.stringify(readDb(id, m)));
    }
    expect(JSON.stringify(currentSnapshot(c, id, m))).toBe(JSON.stringify(readDb(id, m)));
  });
});
