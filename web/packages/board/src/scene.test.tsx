// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-11: the spatial index behind culling, marquee and connector snapping gives exactly what
// the linear scans gave (randomised, with odd boxes), the board uses it, and a commit no longer
// reads the whole board to refresh connector `pts`.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock } from "./index";
import { bbox, getBoardMap, readShapes, type Shape } from "./model";
import { intersects, type Box } from "./ops";
import { SceneIndex } from "./scene";
import { SpatialIndex } from "./spatial";
import { snapTarget, syncArrows, syncBoundArrows } from "./connectors";
import { createArrowResolver } from "./edges";
import { fixtureShapes, makeFixture, rng } from "../bench/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function randomShape(r: () => number, id: string): Shape {
  const t = r();
  if (t < 0.05) return { id, type: "rect", x: NaN, y: 10, w: 10, h: 10 };
  if (t < 0.1) return { id, type: "rect", x: r() * 3000, y: r() * 3000, w: -80, h: -40 };
  if (t < 0.15) return { id, type: "text", x: r() * 3000, y: r() * 3000, text: "hello\nworld", size: 14 };
  if (t < 0.3) return { id, type: "arrow", pts: [[r() * 3000, r() * 3000], [r() * 3000, r() * 3000]] };
  if (t < 0.32) return { id, type: "rect", x: -5000, y: -5000, w: 20000, h: 20000, label: "frame" };
  const types = ["rect", "sticky", "ellipse", "diamond", "image", "pen"] as const;
  const type = types[Math.floor(r() * types.length)];
  return type === "pen" ? { id, type, pts: [[r() * 3000, r() * 3000], [r() * 3000 + 5, r() * 3000 + 5]] } : { id, type, x: r() * 3000, y: r() * 3000, w: 20 + r() * 200, h: 20 + r() * 200 };
}

describe("SceneIndex", () => {
  it("matches the linear scans under random edits (culling, marquee, snapping)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      let list: Shape[] = Array.from({ length: 150 }, (_, i) => randomShape(r, "s" + i));
      const scene = new SceneIndex();
      let next = 150;
      for (let step = 0; step < 60; step++) {
        scene.update(list);
        for (let k = 0; k < 4; k++) {
          const x = r() * 3400 - 200, y = r() * 3400 - 200;
          const q: Box = [x, y, x + r() * 1500, y + r() * 1200];
          expect(scene.inBox(q)).toEqual(list.filter((s) => intersects(bbox(s), q)).map((s) => s.id));
          const keep = list.filter(() => r() < 0.02).map((s) => s.id).concat("missing");
          expect(scene.visible(q, keep)).toEqual(list.filter((s) => intersects(bbox(s), q) || keep.includes(s.id)));
          const p: [number, number] = [r() * 3000, r() * 3000];
          const ex = r() < 0.3 ? list[Math.floor(r() * list.length)]?.id : undefined;
          expect(scene.snap(p, 18, ex)).toEqual(snapTarget(list, p, 18, ex));
        }
        // Edit: move some (new objects), add, delete, reorder; unchanged shapes keep their objects.
        const op = r();
        if (op < 0.5) list = list.map((s) => (r() < 0.05 ? { ...randomShape(r, s.id) } : s));
        else if (op < 0.7) list = [...list, randomShape(r, "s" + next++)];
        else if (op < 0.85) list = list.filter(() => r() > 0.03);
        else {
          const i = Math.floor(r() * list.length);
          list = [...list.slice(0, i), ...list.slice(i + 1), list[i]].filter(Boolean);
        }
      }
    }
  });

  it("a viewport query tests the shapes near it, not the board", () => {
    const list = fixtureShapes({ nodes: 10000 });
    const scene = new SceneIndex();
    scene.update(list);
    const before = scene.stats.tested;
    const vb: Box = [10000, 7000, 11920, 8080];
    const vis = scene.visible(vb);
    expect(vis.length).toBeGreaterThan(20);
    expect(scene.stats.tested - before).toBeLessThan(list.length / 20);
    // One moved node: one shape re-indexed (plus its re-resolved connectors in the real flow).
    const moved = list.slice();
    moved[5] = { ...moved[5], x: (moved[5].x ?? 0) + 10 };
    const u = scene.stats.updated;
    scene.update(moved);
    expect(scene.stats.updated - u).toBe(1);
  });
});

describe("commit-time connector sync", () => {
  it("syncArrows over the affected connectors writes what syncBoundArrows writes", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const r = rng(seed);
      const a = makeFixture({ nodes: 60, seed });
      const b = new Y.Doc();
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
      const resolver = createArrowResolver();
      resolver(readShapes(getBoardMap(a.doc, a.boardId)!));
      for (let step = 0; step < 12; step++) {
        const ids = a.nodeIds.filter(() => r() < 0.05).concat(r() < 0.3 ? [a.edgeIds[Math.floor(r() * a.edgeIds.length)]] : []);
        for (const d of [a.doc, b]) {
          const shapes = getBoardMap(d, a.boardId)!.get("shapes") as Y.Map<Y.Map<unknown>>;
          const rr = rng(seed * 100 + step);
          d.transact(() => {
            for (const id of ids) {
              const y = shapes.get(id)!;
              if (y.get("type") === "arrow") y.set("route", rr() < 0.5 ? "elbow" : "straight");
              else y.set("x", (y.get("x") as number) + Math.round(rr() * 200 - 100));
            }
          });
        }
        syncArrows(a.doc, a.boardId, [...ids, ...resolver.edges.affectedBy(ids), ...resolver.stale]);
        syncBoundArrows(b, a.boardId);
        const sa = readShapes(getBoardMap(a.doc, a.boardId)!), sb = readShapes(getBoardMap(b, a.boardId)!);
        expect(sa).toEqual(sb);
        resolver(sa);
        expect(resolver.stale.size).toBe(0);
      }
    }
  });
});

/* ------------------------------------------------------------------ the board */

const env: BlockEnv = { role: "edit", compact: false, me: { id: "u", name: "U", color: "#2a5ad7" }, users: [], toast: () => {} };
const size = { w: 0, h: 0 };
beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "clientWidth", { configurable: true, get() { return (this as Element).classList.contains("ocbd-svg") ? size.w : 0; } });
  Object.defineProperty(SVGElement.prototype, "clientHeight", { configurable: true, get() { return (this as Element).classList.contains("ocbd-svg") ? size.h : 0; } });
});
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  delete (SVGElement.prototype as { clientWidth?: number }).clientWidth;
  delete (SVGElement.prototype as { clientHeight?: number }).clientHeight;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
async function mount(doc: Y.Doc, boardId: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<BoardBlock doc={doc} boardId={boardId} env={env} />));
  // The first measure happens in a frame.
  await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
  cleanup = () => act(() => root.unmount());
  return { host, root };
}
const drawn = (host: HTMLElement) => [...host.querySelectorAll("svg.ocbd-svg > g > g[data-s]")].map((g) => g.getAttribute("data-s"));

describe("board view through the scene index", () => {
  it("culls through the spatial index and draws exactly what the linear filter keeps", async () => {
    size.w = 800;
    size.h = 600;
    const search = vi.spyOn(SpatialIndex.prototype, "search");
    const fx = makeFixture({ nodes: 2000 });
    const { host } = await mount(fx.doc, fx.boardId);
    // Zoom in (Ctrl+wheel) so most of the board is outside the view.
    const svg = host.querySelector("svg.ocbd-svg")!;
    await act(async () => void svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true })));
    expect(search).toHaveBeenCalled();
    const g = host.querySelector("svg.ocbd-svg > g[transform]")!;
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g.getAttribute("transform")!)!;
    const [tx, ty, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const mg = 200 / z;
    const vb: Box = [-tx / z - mg, -ty / z - mg, (size.w - tx) / z + mg, (size.h - ty) / z + mg];
    const all = createArrowResolver()(readShapes(getBoardMap(fx.doc, fx.boardId)!));
    const want = all.filter((s) => intersects(bbox(s), vb)).map((s) => s.id);
    expect(want.length).toBeLessThan(all.length);
    expect(drawn(host)).toEqual(want);
  });

  it("a nudge commits without reading the whole board", async () => {
    size.w = 800;
    size.h = 600;
    const fx = makeFixture({ nodes: 1500 });
    const { host } = await mount(fx.doc, fx.boardId);
    const root = host.querySelector(".ocbd") as HTMLElement;
    // Select a node with a connector bound to it (click it), then nudge it with an arrow key.
    const id = fx.nodeIds[Math.floor(fx.nodeIds.length / 2)];
    const node = host.querySelector(`g[data-s="${id}"]`)!;
    const e = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 1 });
    Object.defineProperty(e, "pointerType", { value: "mouse" });
    await act(async () => void node.dispatchEvent(e));
    await act(async () => void root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    const toJSON = vi.spyOn(Y.Map.prototype, "toJSON");
    const before = readShapes(getBoardMap(fx.doc, fx.boardId)!).find((s) => s.id === id)!;
    toJSON.mockClear();
    await act(async () => void root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true })));
    const reads = toJSON.mock.calls.length;
    const after = readShapes(getBoardMap(fx.doc, fx.boardId)!);
    expect(after.find((s) => s.id === id)!.x).toBe((before.x ?? 0) + 10);
    // Connectors bound to the node follow in the stored `pts` too (what syncBoundArrows did).
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(fx.doc));
    syncBoundArrows(copy, fx.boardId);
    expect(readShapes(getBoardMap(copy, fx.boardId)!)).toEqual(after);
    expect(reads).toBeLessThan(100);
  });
});
