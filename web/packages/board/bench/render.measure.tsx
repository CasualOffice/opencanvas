// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Render commits per remote edit for a mounted BoardBlock (DGM-02). jsdom has no layout, so the
// board's size is 0 and viewport culling is off: every shape renders (the browser's worst case,
// and what it does for boards up to 300 shapes). Times are jsdom + React, not paint.
import { Profiler, act } from "react";
import { createRoot } from "react-dom/client";
import { it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock } from "../src/index";
import { getBoardMap, moveShapes, updateShape, type Shape } from "../src/model";
import { makeFixture, rng } from "./fixtures";
import { env as hostEnv, save, stats } from "./report";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env: BlockEnv = { role: "edit", compact: false, me: { id: "u", name: "U", color: "#2a5ad7" }, users: [], toast: () => {} };
const SIZES = (process.env.BENCH_RENDER_SIZES ?? "1000,5000").split(",").map(Number);
const EDITS = 40;

it("render commits per remote transaction", async () => {
  const out: Record<string, unknown>[] = [];
  for (const n of SIZES) {
    const fx = makeFixture({ nodes: n, seed: 7 });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(fx.doc));
    remote.on("update", (u: Uint8Array) => Y.applyUpdate(fx.doc, u, "remote"));
    let commits = 0, dur = 0;
    const onRender = (_id: string, _phase: string, actual: number) => {
      commits++;
      dur += actual;
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const t0 = performance.now();
    await act(async () => root.render(<Profiler id="b" onRender={onRender}><BoardBlock doc={fx.doc} boardId={fx.boardId} env={env} /></Profiler>));
    const mountMs = performance.now() - t0;
    const r = rng(99);
    const run = async (label: string, edit: (i: number) => void) => {
      commits = 0;
      dur = 0;
      const wall: number[] = [];
      for (let i = 0; i < EDITS; i++) {
        const t = performance.now();
        await act(async () => edit(i));
        wall.push(performance.now() - t);
      }
      return { workload: label, edits: EDITS, commitsPerEdit: commits / EDITS, reactMsPerEdit: +(dur / EDITS).toFixed(2), wallMs: stats(wall) };
    };
    const shapes = () => getBoardMap(remote, fx.boardId)!.get("shapes") as Y.Map<Y.Map<unknown>>;
    const rows = [
      await run("move one node", () => {
        const id = fx.nodeIds[Math.floor(r() * fx.nodeIds.length)];
        moveShapes(remote, fx.boardId, [{ id, patch: { x: ((shapes().get(id)!.get("x") as number) ?? 0) + 10 } }]);
      }),
      await run("rewrite a node's text with the same value", () => {
        const id = fx.nodeIds[Math.floor(r() * fx.nodeIds.length)];
        shapes().get(id)!.set("text", shapes().get(id)!.get("text"));
      }),
      await run("edit another board", (i) => {
        if (i === 0) remote.getMap("boards").set("other", new Y.Map());
        updateShape(remote, "other", "x", { text: String(i) } as Partial<Shape>);
        (remote.getMap("boards").get("other") as Y.Map<unknown>).set("k", i);
      }),
      await run("edit document text", (i) => {
        remote.getText("bench-text").insert(0, String(i));
      }),
    ];
    for (const row of rows) out.push({ nodes: n, edges: fx.edgeIds.length, mountMs: +mountMs.toFixed(0), ...row });
    await act(async () => root.unmount());
    host.remove();
  }
  console.table(out.map((o) => ({ ...o, wallMs: JSON.stringify(o.wallMs) })));
  save("render", { env: hostEnv(), rows: out });
});
