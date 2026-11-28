// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
// Timeline and Workload on a database with no rows, or no dated rows, must render, not crash.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "../index";
import { createDatabase, deleteRow, getDbMap, readDb, setView } from "../model";
import type { ViewKind } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const env: BlockEnv = { role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} };
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; document.body.innerHTML = ""; });

function emptyDb(view: ViewKind, preset: Parameters<typeof createDatabase>[1]) {
  const doc = new Y.Doc();
  const id = createDatabase(doc, preset);
  for (const r of readDb(id, getDbMap(doc, id)!).rows) deleteRow(doc, id, r.id);
  setView(doc, id, view);
  const errors: unknown[] = [];
  const onErr = (e: ErrorEvent) => { errors.push(e.error); e.preventDefault(); };
  window.addEventListener("error", onErr);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<DatabaseBlock doc={doc} dbId={id} env={env} />));
  cleanup = () => { act(() => root.unmount()); window.removeEventListener("error", onErr); };
  return { el, errors };
}

describe("empty databases", () => {
  for (const view of ["timeline", "workload"] as ViewKind[]) {
    for (const preset of ["blank", "tasks"] as const) {
      it(`${view} renders with no rows (${preset})`, () => {
        const { el, errors } = emptyDb(view, preset);
        expect(errors).toEqual([]);
        expect(el.querySelector(".ocdb")).not.toBeNull();
        expect(el.textContent).not.toMatch(/NaN|Infinity|undefined/);
      });
    }
  }
});

describe("empty states say what to do", () => {
  it("an empty workload explains itself instead of showing a bare header", () => {
    const { el } = emptyDb("workload", "tasks");
    expect(el.querySelector(".ocdb-wl .ocdb-tl-none")?.textContent).toMatch(/Nothing to plan yet/);
  });
});
