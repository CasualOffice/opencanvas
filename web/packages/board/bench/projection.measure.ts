// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Projection cost per edit, memory and serialized size for 1k / 5k / 10k node boards (DGM-02).
// "before" = the v0.1.1 projection (bench/legacy.ts) + `withResolvedArrows`; "after" =
// `BoardProjection` + `createArrowResolver`. Workload: remote transactions from a second Y.Doc,
// each moving one random node by 10 px (a collaborator dragging, one committed step per update).
import { it } from "vitest";
import * as Y from "yjs";
import { bbox, getBoardMap, moveShapes, type Shape } from "../src/model";
import { withResolvedArrows } from "../src/connectors";
import { createArrowResolver } from "../src/edges";
import { BoardProjection } from "../src/projection";
import { SpatialIndex } from "../src/spatial";
import { intersects, type Box } from "../src/ops";
import { LegacyProjection } from "./legacy";
import { makeFixture, rng } from "./fixtures";
import { env, heapMB, save, stats } from "./report";

const SIZES = (process.env.BENCH_SIZES ?? "1000,5000,10000").split(",").map(Number);
const EDITS = Number(process.env.BENCH_EDITS ?? 200);
const MAX_DOC_BYTES = 20 * 1024 * 1024;

function time<T>(f: () => T): [T, number] {
  const t = performance.now();
  const v = f();
  return [v, performance.now() - t];
}

it("projection, memory and size", () => {
  const rows: Record<string, unknown>[] = [];
  for (const n of SIZES) {
    const base0 = heapMB();
    const fx = makeFixture({ nodes: n, seed: 7 });
    const docHeap = +(heapMB() - base0).toFixed(1);
    const yBytes = Y.encodeStateAsUpdate(fx.doc).length;
    const jsonBytes = JSON.stringify(getBoardMap(fx.doc, fx.boardId)!.toJSON()).length;
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(fx.doc));
    const updates: number[] = [];
    remote.on("update", (u: Uint8Array) => {
      updates.push(u.length);
      Y.applyUpdate(fx.doc, u, "remote");
    });
    const shapesY = getBoardMap(remote, fx.boardId)!.get("shapes") as Y.Map<Y.Map<unknown>>;

    // One edit stream, measured for both projections on the same doc (both subscribed).
    const h0 = heapMB();
    const legacy = new LegacyProjection(fx.doc, fx.boardId);
    let [legacyList, legacyFirst] = time(() => legacy.get()!);
    let [legacyResolved] = time(() => withResolvedArrows(legacyList));
    const legacyHeap = +(heapMB() - h0).toFixed(1);
    const h1 = heapMB();
    const proj = new BoardProjection(fx.doc, fx.boardId);
    proj.subscribe(() => {});
    const resolve = createArrowResolver();
    const [list, first] = time(() => proj.get()!);
    resolve(list);
    const newHeap = +(heapMB() - h1).toFixed(1);
    void legacyResolved;

    const r = rng(42);
    const legacyMs: number[] = [], legacyArrowMs: number[] = [], newMs: number[] = [], newArrowMs: number[] = [];
    const reads: number[] = [], resolved: number[] = [];
    const arrowCount = list.filter((s) => s.type === "arrow" && (s.start || s.end || s.route || s.via)).length;
    for (let i = 0; i < EDITS; i++) {
      const id = fx.nodeIds[Math.floor(r() * fx.nodeIds.length)];
      moveShapes(remote, fx.boardId, [{ id, patch: { x: ((shapesY.get(id)!.get("x") as number) ?? 0) + 10 } }]);
      // before
      const [l, lt] = time(() => legacy.get()!);
      const [, lat] = time(() => withResolvedArrows(l));
      legacyMs.push(lt);
      legacyArrowMs.push(lat);
      legacyList = l;
      // after
      const r0 = proj.stats.reads, a0 = resolve.stats.resolved;
      const [p, pt] = time(() => proj.get()!);
      const [, pat] = time(() => resolve(p));
      newMs.push(pt);
      newArrowMs.push(pat);
      reads.push(proj.stats.reads - r0);
      resolved.push(resolve.stats.resolved - a0);
    }
    legacy.destroy();

    // Spatial index vs the linear viewport filter (BoardBlock culling) on a 1920×1080 viewport.
    const shapes: Shape[] = proj.get()!;
    const [idx, idxBuild] = time(() => SpatialIndex.ofShapes(shapes));
    const vq = rng(9);
    const linear: number[] = [], indexed: number[] = [], upd: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x = vq() * 220 * Math.sqrt(n), y = vq() * 160 * Math.sqrt(n);
      const vb: Box = [x, y, x + 1920, y + 1080];
      linear.push(time(() => shapes.filter((s) => intersects(bbox(s), vb)).length)[1]);
      indexed.push(time(() => idx.search(vb).length)[1]);
      const s = shapes[Math.floor(vq() * shapes.length)];
      const b = bbox(s);
      upd.push(time(() => idx.set(s.id, [b[0] + 10, b[1], b[2] + 10, b[3]]))[1]);
    }

    rows.push({
      nodes: n,
      edges: fx.edgeIds.length,
      yjsBytes: yBytes,
      jsonBytes,
      bytesPerShape: Math.round(yBytes / (n + fx.edgeIds.length)),
      shareOfDocLimit: +(yBytes / MAX_DOC_BYTES).toFixed(3),
      updateBytesPerMove: stats(updates.slice(-EDITS)),
      docHeapMB: docHeap,
      projectionHeapMB: { before: legacyHeap, after: newHeap },
      firstProjectionMs: { before: +legacyFirst.toFixed(2), after: +first.toFixed(2) },
      perEditProjectionMs: { before: stats(legacyMs), after: stats(newMs) },
      perEditArrowResolveMs: { before: stats(legacyArrowMs), after: stats(newArrowMs) },
      shapesReReadPerEdit: { before: n + fx.edgeIds.length, after: stats(reads).mean },
      arrowsResolvedPerEdit: { before: arrowCount, after: stats(resolved).mean },
      spatial: { buildMs: +idxBuild.toFixed(2), viewportLinearMs: stats(linear), viewportIndexMs: stats(indexed), moveUpdateMs: stats(upd) },
    });
  }
  for (const row of rows) console.log(JSON.stringify(row));
  save("projection", { env: env(), edits: EDITS, workload: "remote transactions, each moving one random node by 10 px", rows });
});
