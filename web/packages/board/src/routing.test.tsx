// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-13 (ADR-047): obstacle-aware orthogonal routing. The router is deterministic (randomised:
// same input in any obstacle order, same route), keeps clear of obstacles, and the incremental
// router equals routing everything from scratch after random edits, also with deferred and
// cancelled background batches. Stored as `route: "elbow"` + `routing: "avoid"`, set through
// the model API only (no UI sets it).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock } from "./index";
import { addShape, bbox, createBoard, getBoardMap, readShapes, updateShape, type Pt, type Shape } from "./model";
import type { Box } from "./ops";
import { CLEARANCE, routeOrthogonal, runJob, type RouteEnd, type Side } from "./router";
import { AvoidRouter, avoidEnds, RouteScheduler } from "./routing";
import { createArrowResolver } from "./edges";
import { resolveArrow, syncBoundArrows } from "./connectors";
import { rng } from "../bench/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIDES: Side[] = ["top", "right", "bottom", "left"];
const shuffle = <T,>(xs: T[], r: () => number) => {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const query = (boxes: Box[]) => (R: Box) => boxes.filter((o) => o[0] <= R[2] && o[2] >= R[0] && o[1] <= R[3] && o[3] >= R[1]);

/** Segment (p, q) passes through the open interior of box b. */
function crosses(p: Pt, q: Pt, b: Box): boolean {
  const [x0, y0, x1, y1] = b;
  if (p[1] === q[1]) return p[1] > y0 && p[1] < y1 && Math.max(p[0], q[0]) > x0 && Math.min(p[0], q[0]) < x1;
  return p[0] > x0 && p[0] < x1 && Math.max(p[1], q[1]) > y0 && Math.min(p[1], q[1]) < y1;
}

describe("router", () => {
  it("goes around a shape between the two ends", () => {
    const A: Box = [0, 0, 100, 60], B: Box = [400, 0, 500, 60], C: Box = [200, -40, 260, 100];
    const r = routeOrthogonal({ p: [100, 30], side: "right" }, { p: [400, 30], side: "left" }, query([A, B, C]));
    const pts = r.pts!;
    expect(pts[0]).toEqual([100, 30]);
    expect(pts[pts.length - 1]).toEqual([400, 30]);
    expect(pts.length).toBeGreaterThan(4);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]).toBe(true);
      for (const o of [A, B, C]) expect(crosses(pts[i - 1], pts[i], o), JSON.stringify(pts)).toBe(false);
    }
    // It leaves A to the right and enters B from the left, each for at least the clearance.
    expect(pts[1][1]).toBe(30);
    expect(pts[1][0] - 100).toBeGreaterThanOrEqual(CLEARANCE);
    expect(pts[pts.length - 2][1]).toBe(30);
  });

  it("is deterministic: same route for the same input in any obstacle order (randomised)", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const boxes: Box[] = Array.from({ length: Math.floor(r() * 25) }, () => {
        const x = Math.round(r() * 1200), y = Math.round(r() * 900);
        return [x, y, x + 30 + Math.round(r() * 160), y + 30 + Math.round(r() * 120)];
      });
      const end = (): RouteEnd => ({ p: [Math.round(r() * 12000) / 10, Math.round(r() * 9000) / 10], side: r() < 0.2 ? undefined : SIDES[Math.floor(r() * 4)] });
      const a = end(), b = end();
      const one = routeOrthogonal(a, b, query(boxes));
      const two = routeOrthogonal(a, b, query(shuffle(boxes, r)));
      expect(two, `seed ${seed}`).toEqual(one);
      if (!one.pts) continue;
      const pts = one.pts;
      expect(pts[0]).toEqual(a.p);
      expect(pts[pts.length - 1]).toEqual(b.p);
      const c = CLEARANCE;
      const holds = (o: Box, p: Pt) => p[0] > o[0] - c && p[0] < o[2] + c && p[1] > o[1] - c && p[1] < o[3] + c;
      const stub = (e: RouteEnd): Pt => (e.side === "right" ? [e.p[0] + c, e.p[1]] : e.side === "left" ? [e.p[0] - c, e.p[1]] : e.side === "top" ? [e.p[0], e.p[1] - c] : e.side === "bottom" ? [e.p[0], e.p[1] + c] : e.p);
      // Between the stubs, no segment passes through an obstacle (except one holding a stub).
      for (let i = 2; i < pts.length - 1; i++) {
        expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1], `seed ${seed}`).toBe(true);
        for (const o of boxes) if (!holds(o, stub(a)) && !holds(o, stub(b))) expect(crosses(pts[i - 1], pts[i], o), `seed ${seed} ${JSON.stringify(pts)}`).toBe(false);
      }
    }
  });
});

/* -------------------------------------------------------------- the incremental router */

function board(r: () => number, nodes = 40, edges = 30): Shape[] {
  const out: Shape[] = [];
  for (let i = 0; i < nodes; i++) out.push({ id: "n" + i, type: i % 5 === 0 ? "ellipse" : "rect", x: Math.round(r() * 1600), y: Math.round(r() * 1200), w: 60 + Math.round(r() * 100), h: 40 + Math.round(r() * 60) });
  for (let k = 0; k < edges; k++) {
    const a = Math.floor(r() * nodes), b = (a + 1 + Math.floor(r() * (nodes - 1))) % nodes;
    const anchor = () => (["top", "right", "bottom", "left", "center"] as const)[Math.floor(r() * 5)];
    out.push({ id: "e" + k, type: "arrow", pts: [[0, 0], [1, 1]], route: "elbow", start: { shapeId: "n" + a, anchor: anchor() }, end: { shapeId: "n" + b, anchor: anchor() }, ...(r() < 0.8 ? { routing: "avoid" as const } : {}) });
  }
  return out;
}

/** One random edit, keeping unchanged shapes as the same objects. */
function edit(list: Shape[], r: () => number, next: { n: number }): Shape[] {
  const op = r();
  const nodes = list.filter((s) => s.type !== "arrow");
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  if (op < 0.45) {
    const n = pick(nodes);
    return list.map((s) => (s === n ? { ...s, x: (s.x ?? 0) + Math.round(r() * 300 - 150), y: (s.y ?? 0) + Math.round(r() * 200 - 100) } : s));
  }
  if (op < 0.55) return [...list.slice(0, nodes.length), { id: "m" + next.n++, type: "rect", x: Math.round(r() * 1600), y: Math.round(r() * 1200), w: 120, h: 80 }, ...list.slice(nodes.length)];
  if (op < 0.65) {
    const n = pick(nodes);
    return list.filter((s) => s !== n);
  }
  if (op < 0.8) {
    const e = pick(list.filter((s) => s.type === "arrow"));
    return e ? list.map((s) => (s === e ? { ...s, routing: s.routing ? undefined : "avoid" } : s)) : list;
  }
  if (op < 0.9) {
    const e = pick(list.filter((s) => s.type === "arrow"));
    return e ? list.map((s) => (s === e ? { ...s, end: { shapeId: pick(nodes).id, anchor: "left" as const } } : s)) : list;
  }
  const e = pick(list.filter((s) => s.type === "arrow"));
  return e ? list.map((s) => (s === e ? { ...s, text: "t" + next.n++ } : s)) : list;
}

const fresh = (resolved: Shape[]) => new AvoidRouter().apply(resolved);
const pts = (list: Shape[]) => list.filter((s) => s.type === "arrow").map((s) => [s.id, s.pts]);

describe("AvoidRouter", () => {
  it("draws avoid connectors with their route and every other shape untouched", () => {
    const r = rng(7);
    const raw = board(r);
    const resolved = createArrowResolver()(raw);
    const out = new AvoidRouter().apply(resolved);
    const byId = new Map(resolved.map((s) => [s.id, s]));
    let routed = 0;
    out.forEach((s, i) => {
      if (s.routing !== "avoid") return expect(s).toBe(resolved[i]);
      const ends = avoidEnds(s, byId)!;
      const want = routeOrthogonal(ends.a, ends.b, query(resolved.filter((q) => q.type !== "arrow").map((q) => bbox(q)))).pts ?? resolved[i].pts;
      expect(s.pts).toEqual(want);
      if (s.pts !== resolved[i].pts) routed++;
    });
    expect(routed).toBeGreaterThan(5);
  });

  it("incremental routing equals routing from scratch after random edits (randomised)", () => {
    let inc = 0, full = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(seed);
      const resolver = createArrowResolver();
      const router = new AvoidRouter();
      let raw = board(r);
      const next = { n: 0 };
      for (let step = 0; step < 15; step++) {
        const resolved = resolver(raw);
        const before = router.stats.routed;
        const a = router.apply(resolved);
        inc += router.stats.routed - before;
        const f = new AvoidRouter();
        const b = f.apply(resolved);
        full += f.stats.routed;
        expect(pts(a), `seed ${seed} step ${step}`).toEqual(pts(b));
        raw = edit(raw, r, next);
      }
    }
    // Most routes are reused (a moved node invalidates every route whose region it meets).
    expect(inc).toBeLessThan(full / 2);
  }, 60_000);

  it("defers over budget, takes background results by version, and drops stale ones", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(100 + seed);
      const resolver = createArrowResolver();
      const router = new AvoidRouter();
      let raw = board(r);
      const next = { n: 0 };
      let out = router.apply(resolver(raw), 0);
      expect(router.pending.size).toBeGreaterThan(0);
      // Pending connectors draw as the plain elbow meanwhile.
      for (const id of router.pending) expect(out.find((s) => s.id === id)!.pts).toEqual(resolver(raw).find((s) => s.id === id)!.pts);
      let jobs = router.jobs();
      // Run half the jobs, then an edit lands before the results do: stale ones are dropped.
      const early = jobs.slice(0, jobs.length >> 1).map(runJob);
      raw = edit(edit(raw, r, next), r, next);
      router.apply(resolver(raw), 0);
      router.accept(early);
      jobs = router.jobs();
      router.accept(jobs.map(runJob));
      out = router.apply(resolver(raw), 0);
      expect(router.pending.size).toBe(0);
      expect(pts(out), `seed ${seed}`).toEqual(pts(fresh(resolver(raw))));
    }
  });

  it("the scheduler routes pending connectors in the background; a newer batch cancels the old", async () => {
    const r = rng(9);
    const resolver = createArrowResolver();
    const router = new AvoidRouter();
    let raw = board(r, 60, 50);
    router.apply(resolver(raw), 0);
    const s = new RouteScheduler(router);
    let landed = 0;
    router.subscribe(() => landed++);
    s.run();
    // Before the first chunk runs, the board changes and a new batch starts.
    raw = edit(raw, r, { n: 0 });
    router.apply(resolver(raw), 0);
    s.run();
    // Wait for the background chunks to drain rather than a fixed delay: CI runners are slower.
    await vi.waitFor(() => expect(router.pending.size).toBe(0), { timeout: 5000, interval: 10 });
    expect(landed).toBeGreaterThan(0);
    expect(pts(router.apply(resolver(raw), 0))).toEqual(pts(fresh(resolver(raw))));
    s.cancel();
  });
});

/* ------------------------------------------------------------------ board and exporters */

const env: BlockEnv = { role: "edit", compact: false, me: { id: "u", name: "U", color: "#2a5ad7" }, users: [], toast: () => {} };
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

function routed() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 0, y: 0, w: 100, h: 60 });
  const b = addShape(doc, id, { type: "rect", x: 400, y: 0, w: 100, h: 60 });
  const c = addShape(doc, id, { type: "rect", x: 200, y: -40, w: 60, h: 140, text: "in the way" });
  const e = addShape(doc, id, { type: "arrow", pts: [[100, 30], [400, 30]], start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" }, route: "elbow", routing: "avoid" });
  return { doc, id, a, b, c, e };
}

describe("routing on the board (model API only)", () => {
  it("the board draws an avoid connector along its route; the commit stores that route", async () => {
    const { doc, id, a, e } = routed();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<BoardBlock doc={doc} boardId={id} env={env} />));
    cleanup = () => act(() => root.unmount());
    const shapes = readShapes(getBoardMap(doc, id)!);
    const byId = new Map(shapes.map((s) => [s.id, s]));
    const ends = avoidEnds(byId.get(e)!, byId)!;
    const want = routeOrthogonal(ends.a, ends.b, query(shapes.filter((s) => s.type !== "arrow").map((s) => bbox(s)))).pts!;
    expect(want.length).toBeGreaterThan(4);
    const path = host.querySelector(`g[data-s="${e}"] path`)!.getAttribute("d");
    expect(path).toBe("M" + want.map((q) => q.join(" ")).join(" L"));

    // Nudge the start node (select it, Shift+Right): the stored pts become the new route.
    const node = host.querySelector(`g[data-s="${a}"]`)!;
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0 });
    Object.defineProperty(down, "pointerId", { value: 1 });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    await act(async () => void node.dispatchEvent(down));
    await act(async () => void host.querySelector(".ocbd")!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    await act(async () => void host.querySelector(".ocbd")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true })));
    const after = readShapes(getBoardMap(doc, id)!);
    const m = new Map(after.map((s) => [s.id, s]));
    const ends2 = avoidEnds(m.get(e)!, m)!;
    const want2 = routeOrthogonal(ends2.a, ends2.b, query(after.filter((s) => s.type !== "arrow").map((s) => bbox(s)))).pts!;
    expect(m.get(e)!.pts).toEqual(want2);
    expect(host.querySelector(`g[data-s="${e}"] path`)!.getAttribute("d")).toBe("M" + want2.map((q) => q.join(" ")).join(" L"));
  });

  it("readers without a router (0.1.x, the exporters) draw the plain elbow", () => {
    const { doc, id, e } = routed();
    const shapes = readShapes(getBoardMap(doc, id)!);
    const byId = new Map(shapes.map((s) => [s.id, s]));
    const elbow = resolveArrow(byId.get(e)!, byId);
    expect(elbow).toEqual([[100, 30], [400, 30]]);
    // syncBoundArrows (no router) writes the plain elbow: older writers keep a sensible snapshot.
    updateShape(doc, id, e, { pts: [[100, 30], [116, 30], [116, -56], [400, -56], [400, 30]] });
    syncBoundArrows(doc, id);
    expect(readShapes(getBoardMap(doc, id)!).find((q) => q.id === e)!.pts).toEqual(elbow);
  });
});
