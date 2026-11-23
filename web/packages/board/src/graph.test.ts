// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-03 (registry), DGM-04 (ports, semantic edges), DGM-06 (spatial index), DGM-05 (arrow
// resolution keeps unaffected connectors).
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addShape, bbox, createBoard, getBoardMap, moveShapes, readShapes, updateShape, type Shape } from "./model";
import { anchorPoint, ANCHORS, resolveArrow, withResolvedArrows } from "./connectors";
import { CORE_KINDS, FALLBACK, descriptorOf, isKind, kindOf, makeNode, registerShape, registeredKinds, unregisterShape } from "./registry";
import { LEGACY_PORTS, anchorFor, bindingPort, bindingTo, nearestPort, portPoint, portsOf, readPorts } from "./ports";
import { EdgeIndex, createArrowResolver, edgeOf, edgePatch, orphanEnds } from "./edges";
import { SpatialIndex } from "./spatial";
import { BoardProjection } from "./projection";
import { makeFixture, rng } from "../bench/fixtures";

afterEach(() => {
  for (const k of registeredKinds()) if (!k.startsWith("core:")) unregisterShape(k);
});

describe("shape registry", () => {
  it("describes the nine legacy types as core kinds", () => {
    expect(CORE_KINDS).toHaveLength(9);
    expect(kindOf({ id: "a", type: "rect" })).toBe("core:rect");
    expect(descriptorOf({ id: "a", type: "ellipse" })).toMatchObject({ kind: "core:ellipse", base: "ellipse", bindable: true });
    expect(descriptorOf({ id: "a", type: "arrow" }).bindable).toBe(false);
    expect(descriptorOf({ id: "a", type: "pen" }).bindable).toBe(false);
  });

  it("validates namespaced kinds", () => {
    for (const ok of ["uml:class", "network:load-balancer", "erd:entity2"]) expect(isKind(ok), ok).toBe(true);
    for (const bad of ["rect", "UML:class", "uml:", ":x", "a:b:c", "uml:Class", "x".repeat(40) + ":a", 5, null]) expect(isKind(bad), String(bad)).toBe(false);
  });

  it("registers declarative descriptors and refuses bad ones", () => {
    const d = registerShape({ kind: "uml:class", base: "rect", version: 1, label: "Class", ports: [{ id: "in", side: "left", x: 0, y: 0.3 }] });
    expect(Object.isFrozen(d)).toBe(true);
    expect(descriptorOf({ id: "x", type: "rect", kind: "uml:class" })).toBe(d);
    expect(() => registerShape({ kind: "core:thing", base: "rect", version: 1 })).toThrow(/core/);
    expect(() => registerShape({ kind: "Bad", base: "rect", version: 1 })).toThrow(/kind/);
    expect(() => registerShape({ kind: "uml:edge", base: "arrow", version: 1 })).toThrow(/base/);
    expect(() => registerShape({ kind: "uml:x", base: "rect", version: 0 })).toThrow(/version/);
    expect(() => registerShape({ kind: "uml:y", base: "rect", version: 1, render: () => null } as never)).toThrow(/declarative/);
    expect(() => registerShape({ kind: "uml:class", base: "rect", version: 1 })).toThrow(/already/);
  });

  it("falls back to the base type when a kind's plugin is missing, and keeps the kind", () => {
    const s: Shape = { id: "x", type: "rect", kind: "network:router", kindVersion: 3, props: { model: "x" } };
    const d = descriptorOf(s);
    expect(d).toMatchObject({ kind: "core:rect", base: "rect", missing: "network:router" });
    expect(kindOf(s)).toBe("network:router");
  });

  it("gives an unknown type the generic fallback: a bindable box with the legacy ports", () => {
    const s = { id: "x", type: "bpmn:task", x: 0, y: 0, w: 10, h: 10 } as unknown as Shape;
    expect(descriptorOf(s)).toMatchObject({ kind: FALLBACK.kind, base: "rect", bindable: true, missing: "bpmn:task" });
    expect(kindOf(s)).toBe("bpmn:task");
    expect(kindOf({ id: "x", type: "???" } as unknown as Shape)).toBe("core:unknown");
    expect(portsOf(s).map((p) => p.id)).toEqual(ANCHORS);
  });

  it("makeNode writes the base type, the kind and its version", () => {
    registerShape({ kind: "erd:entity", base: "rect", version: 2 });
    expect(makeNode("erd:entity", { x: 1, y: 2, w: 3, h: 4, text: "User" })).toEqual({ type: "rect", kind: "erd:entity", kindVersion: 2, x: 1, y: 2, w: 3, h: 4, text: "User" });
    expect(makeNode("core:ellipse", { x: 0 })).toEqual({ type: "ellipse", x: 0 });
    expect(() => makeNode("erd:missing", {})).toThrow(/unknown/);
  });
});

describe("ports", () => {
  const box: Shape = { id: "b", type: "rect", x: 100, y: 50, w: 200, h: 100 };

  it("maps the five legacy anchors to ports at exactly the anchor points", () => {
    expect(LEGACY_PORTS.map((p) => p.id)).toEqual(ANCHORS);
    for (const shape of [box, { ...box, type: "ellipse" as const }, { id: "t", type: "text" as const, x: 0, y: 30, text: "Hello\nworld", size: 18 }]) {
      for (const a of ANCHORS) expect(portPoint(shape, a)).toEqual(anchorPoint(shape, a));
    }
  });

  it("reads custom ports defensively", () => {
    expect(readPorts([{ id: "in", side: "left", x: 0, y: 0.25 }, { id: "in" }, { id: "top" }, { id: 5 }, { id: "o", x: 3, y: -1, side: "up" }, "junk"])).toEqual([
      { id: "in", side: "left", x: 0, y: 0.25 },
      { id: "o", x: 1, y: 0 },
    ]);
    expect(readPorts("nope")).toEqual([]);
  });

  it("places custom ports on the box and degrades them to a legacy anchor", () => {
    const s: Shape = { ...box, ports: [{ id: "in", side: "left", x: 0, y: 0.25 }, { id: "low", x: 0.9, y: 1 }] };
    expect(portsOf(s).map((p) => p.id)).toEqual([...ANCHORS, "in", "low"]);
    expect(portPoint(s, "in")).toEqual([100, 75]);
    expect(portPoint(s, "low")).toEqual([280, 150]);
    expect(portPoint(s, "nope")).toBeNull();
    expect(anchorFor(s, "in")).toBe("left");
    expect(anchorFor(s, "low")).toBe("bottom");
    expect(anchorFor(s, "top")).toBe("top");
    expect(bindingTo(s, "in")).toEqual({ shapeId: "b", anchor: "left", port: "in" });
    expect(bindingTo(s, "right")).toEqual({ shapeId: "b", anchor: "right" });
    expect(bindingPort({ shapeId: "b", anchor: "left", port: "in" })).toBe("in");
    expect(bindingPort({ shapeId: "b", anchor: "left" })).toBe("left");
    expect(nearestPort(s, [101, 80]).id).toBe("in");
  });

  it("uses a registered kind's default ports", () => {
    registerShape({ kind: "network:switch", base: "rect", version: 1, ports: [{ id: "p1", side: "bottom", x: 0.25, y: 1 }] });
    const s: Shape = { ...box, kind: "network:switch" };
    expect(portsOf(s).map((p) => p.id)).toEqual([...ANCHORS, "p1"]);
    expect(portPoint(s, "p1")).toEqual([150, 150]);
  });
});

describe("semantic edges", () => {
  it("reads an arrow as an edge and writes it back as legacy fields", () => {
    const n: Shape = { id: "n", type: "rect", x: 0, y: 0, w: 100, h: 100, ports: [{ id: "out", side: "right", x: 1, y: 0.8 }] };
    const a: Shape = { id: "a", type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: "n", anchor: "right", port: "out" }, end: { shapeId: "m", anchor: "center" }, route: "elbow", via: [[5, 5]], text: "calls" };
    expect(edgeOf(a)).toEqual({ id: "a", source: { nodeId: "n", portId: "out" }, target: { nodeId: "m", portId: "center" }, route: "orthogonal", waypoints: [[5, 5]], label: "calls" });
    expect(edgeOf(n)).toBeNull();
    expect(edgeOf({ id: "f", type: "arrow", pts: [[0, 0], [1, 1]] })).toEqual({ id: "f", route: "straight", waypoints: [] });
    const byId = new Map([["n", n]]);
    expect(edgePatch({ source: { nodeId: "n", portId: "out" }, route: "orthogonal", waypoints: [], label: "x" }, byId)).toEqual({
      start: { shapeId: "n", anchor: "right", port: "out" },
      route: "elbow",
      via: undefined,
      text: "x",
    });
    // A source on an unknown node keeps the port id as the anchor only when it is a legacy one.
    expect(edgePatch({ source: { nodeId: "zz", portId: "left" } }, byId)).toEqual({ start: { shapeId: "zz", anchor: "left" } });
    expect(edgePatch({ source: { nodeId: "zz", portId: "custom" } }, byId)).toEqual({ start: { shapeId: "zz", anchor: "center", port: "custom" } });
  });

  it("indexes edges by node, incrementally", () => {
    const { doc, boardId } = makeFixture({ nodes: 30, seed: 2 });
    const list = readShapes(getBoardMap(doc, boardId)!);
    const idx = new EdgeIndex();
    idx.load(list);
    for (const n of list.filter((s) => s.type !== "arrow")) {
      const want = list.filter((s) => s.type === "arrow" && (s.start?.shapeId === n.id || s.end?.shapeId === n.id)).map((s) => s.id).sort();
      expect([...idx.edgesAt(n.id)].sort(), n.id).toEqual(want);
    }
    const e = list.find((s) => s.type === "arrow")!;
    const from = e.start!.shapeId;
    idx.set({ ...e, start: { shapeId: "elsewhere", anchor: "top" } });
    expect(idx.edgesAt(from).has(e.id)).toBe(e.end!.shapeId === from);
    expect(idx.edgesAt("elsewhere").has(e.id)).toBe(true);
    idx.delete(e.id);
    expect(idx.edgesAt("elsewhere").size).toBe(0);
    expect([...idx.affectedBy([from])].every((id) => id !== e.id || e.end!.shapeId === from)).toBe(true);
  });

  it("reports edge ends bound to missing nodes", () => {
    const list: Shape[] = [
      { id: "n", type: "rect", x: 0, y: 0, w: 1, h: 1 },
      { id: "a", type: "arrow", pts: [[0, 0], [1, 1]], start: { shapeId: "n", anchor: "top" }, end: { shapeId: "gone", anchor: "left" } },
    ];
    expect(orphanEnds(list)).toEqual([{ edgeId: "a", end: "end", nodeId: "gone" }]);
  });
});

describe("arrow resolver", () => {
  it("equals withResolvedArrows and only re-resolves connectors touching a change", () => {
    const { doc, boardId, nodeIds } = makeFixture({ nodes: 400, seed: 11 });
    const p = new BoardProjection(doc, boardId);
    p.subscribe(() => {});
    const resolve = createArrowResolver();
    let prev = resolve(p.get()!);
    expect(prev).toEqual(withResolvedArrows(p.get()!));
    const r = rng(5);
    for (let i = 0; i < 40; i++) {
      const id = nodeIds[Math.floor(r() * nodeIds.length)];
      const before = resolve.stats.resolved;
      moveShapes(doc, boardId, [{ id, patch: { x: i * 7 } }]);
      const raw = p.get()!;
      const out = resolve(raw);
      expect(out).toEqual(withResolvedArrows(raw));
      const touching = raw.filter((s) => s.type === "arrow" && (s.start?.shapeId === id || s.end?.shapeId === id));
      expect(resolve.stats.resolved - before).toBe(touching.length);
      // Connectors away from the change are the same objects as before.
      out.forEach((s, k) => {
        if (s.type === "arrow" && !touching.some((t) => t.id === s.id)) expect(s).toBe(prev[k]);
      });
      prev = out;
    }
    // No change: same list.
    expect(resolve(p.get()!)).toBe(prev);
  });

  it("equals withResolvedArrows under random rebinds, reroutes, adds and deletes (fuzz)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 13);
      const { doc, boardId } = makeFixture({ nodes: 30, seed });
      const p = new BoardProjection(doc, boardId);
      p.subscribe(() => {});
      const resolve = createArrowResolver();
      for (let step = 0; step < 50; step++) {
        const list = p.get()!;
        const pick = () => list[Math.floor(r() * list.length)];
        const arrows = list.filter((s) => s.type === "arrow");
        const arrow = () => arrows[Math.floor(r() * arrows.length)];
        const op = Math.floor(r() * 7);
        if (op === 0) moveShapes(doc, boardId, [{ id: pick().id, patch: { x: step * 3 } }]);
        else if (op === 1 && arrows.length) updateShape(doc, boardId, arrow().id, { start: { shapeId: pick().id, anchor: ANCHORS[step % 5] } });
        else if (op === 2 && arrows.length) updateShape(doc, boardId, arrow().id, { end: undefined, start: undefined, route: undefined });
        else if (op === 3 && arrows.length) updateShape(doc, boardId, arrow().id, { route: step % 2 ? "elbow" : "straight", via: step % 3 ? [[step, step]] : undefined });
        else if (op === 4) addShape(doc, boardId, { type: "arrow", pts: [[0, 0], [5, 5]], end: { shapeId: pick().id, anchor: "center" } });
        else if (op === 5) getBoardMap(doc, boardId)!.get("shapes") instanceof Y.Map && (getBoardMap(doc, boardId)!.get("shapes") as Y.Map<unknown>).delete(pick().id);
        else updateShape(doc, boardId, pick().id, { w: 10 + step });
        const raw = p.get()!;
        expect(resolve(raw), `seed ${seed} step ${step}`).toEqual(withResolvedArrows(raw));
      }
    }
  });

  it("follows a bound node that appears or disappears", () => {
    const doc = new Y.Doc();
    const bid = createBoard(doc, "blank");
    const a = addShape(doc, bid, { type: "arrow", pts: [[0, 0], [50, 0]], start: { shapeId: "late", anchor: "right" } });
    const p = new BoardProjection(doc, bid);
    p.subscribe(() => {});
    const resolve = createArrowResolver();
    expect(resolve(p.get()!)).toEqual(withResolvedArrows(p.get()!));
    addShape(doc, bid, { id: "late", type: "rect", x: 100, y: 100, w: 20, h: 20 });
    const out = resolve(p.get()!);
    expect(out.find((s) => s.id === a)!.pts![0]).toEqual([120, 110]);
    updateShape(doc, bid, "late", { x: 0 });
    expect(resolve(p.get()!)).toEqual(withResolvedArrows(p.get()!));
  });
});

describe("spatial index", () => {
  type Box4 = [number, number, number, number];
  const hits = (boxes: Map<string, Box4>, q: Box4) =>
    [...boxes].filter(([, b]) => b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1]).map(([id]) => id).sort();

  it("answers box queries like a linear scan, through inserts, moves and deletes", () => {
    const r = rng(8);
    const idx = new SpatialIndex(128);
    const boxes = new Map<string, Box4>();
    const rnd = (): Box4 => {
      const x = (r() - 0.5) * 20000, y = (r() - 0.5) * 20000;
      const big = r() < 0.02;
      const w = big ? r() * 60000 : r() * 300, h = big ? r() * 60000 : r() * 200;
      return [x, y, x + w, y + h];
    };
    for (let i = 0; i < 3000; i++) {
      const b = rnd();
      boxes.set("s" + i, b);
      idx.set("s" + i, b);
    }
    for (let i = 0; i < 500; i++) {
      const id = "s" + Math.floor(r() * 3000);
      if (r() < 0.3) {
        boxes.delete(id);
        idx.delete(id);
      } else {
        const b = rnd();
        boxes.set(id, b);
        idx.set(id, b);
      }
    }
    expect(idx.size).toBe(boxes.size);
    for (let i = 0; i < 300; i++) {
      const x = (r() - 0.5) * 22000, y = (r() - 0.5) * 22000;
      const q: Box4 = r() < 0.1 ? [-1e6, -1e6, 1e6, 1e6] : [x, y, x + r() * 2000, y + r() * 1500];
      expect(idx.search(q).sort(), JSON.stringify(q)).toEqual(hits(boxes, q));
    }
    expect(idx.hit([boxes.get("s1")?.[0] ?? 0, boxes.get("s1")?.[1] ?? 0]).includes("s1")).toBe(boxes.has("s1"));
  });

  it("indexes shapes by their box", () => {
    const shapes: Shape[] = [
      { id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10 },
      { id: "b", type: "text", x: 100, y: 100, text: "hi", size: 18 },
    ];
    const idx = SpatialIndex.ofShapes(shapes);
    expect(idx.get("b")).toEqual(bbox(shapes[1]));
    expect(idx.hit([5, 5])).toEqual(["a"]);
    expect(idx.hit([-3, 5], 4)).toEqual(["a"]);
    expect(idx.hit([-3, 5])).toEqual([]);
  });
});

describe("arrow resolution does not depend on registry state", () => {
  it("resolves the same with or without registered kinds", () => {
    const n: Shape = { id: "n", type: "rect", kind: "uml:class", x: 0, y: 0, w: 100, h: 60 };
    const a: Shape = { id: "a", type: "arrow", pts: [[0, 0], [300, 0]], start: { shapeId: "n", anchor: "right", port: "x" } };
    const before = resolveArrow(a, new Map([["n", n]]));
    registerShape({ kind: "uml:class", base: "rect", version: 1, ports: [{ id: "x", x: 1, y: 0 }] });
    expect(resolveArrow(a, new Map([["n", n]]))).toEqual(before);
  });
});
