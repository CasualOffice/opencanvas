// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Mixed-version compatibility (DGM-07, ADR-045). A newer client writes diagram fields that the
// 0.1.x board code does not know (`kind`, `kindVersion`, `props`, `ports`, `port` inside a
// binding, an unknown `type`). The older client then edits the same shapes through every
// mutation path it has. Nothing it does not understand may be lost or rewritten.
//
// The 0.1.x client is this package's own mutation code: the model.ts, ops.ts and connectors.ts
// writers are as in v0.1.1 except the paste fix below (`git diff v0.1.1 -- web/packages/board/src`
// shows it and type-only additions), so these calls are what a deployed 0.1.1 editor sends.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createBoard, getBoardMap, readShapes, addShape, updateShape, moveShapes, deleteShape, duplicateShape, bringToFront, type Shape } from "./model";
import { cloneShapes, insertShapes, reorderShapes, setGroup, movePatch } from "./ops";
import { syncBoundArrows, withResolvedArrows, resolveArrow } from "./connectors";

const ORIGIN = { test: "old-client" };

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array, o: unknown) => o !== "remote" && Y.applyUpdate(b, u, "remote"));
  b.on("update", (u: Uint8Array, o: unknown) => o !== "remote" && Y.applyUpdate(a, u, "remote"));
  return [a, b] as const;
}

const shapesOf = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const byId = (doc: Y.Doc, bid: string, sid: string) => shapesOf(doc, bid).find((s) => s.id === sid) as Shape & Record<string, unknown>;

/** Fields a newer client writes on a node (diagram schema, ADR-045). */
const NODE_EXTRA = {
  kind: "uml:class",
  kindVersion: 2,
  props: { stereotype: "entity", attrs: [{ name: "id", type: "uuid", pk: true }], nested: { deep: [1, 2, { x: "y" }] } },
  ports: [
    { id: "in", side: "left", x: 0, y: 0.25, kind: "input" },
    { id: "out", side: "right", x: 1, y: 0.75 },
  ],
  futureFlag: true,
};

/** A newer client writes a node and an edge bound to one of its ports, directly with Yjs. */
function seed(doc: Y.Doc) {
  const bid = createBoard(doc, "blank");
  const n1 = addShape(doc, bid, { type: "rect", x: 0, y: 0, w: 160, h: 100, text: "Order", ...NODE_EXTRA } as unknown as Shape);
  const n2 = addShape(doc, bid, { type: "rect", x: 400, y: 0, w: 160, h: 100, text: "Customer" });
  const e = addShape(doc, bid, {
    type: "arrow",
    pts: [[160, 75], [400, 50]],
    start: { shapeId: n1, anchor: "right", port: "out" } as Shape["start"],
    end: { shapeId: n2, anchor: "left", portx: { future: 1 } } as unknown as Shape["end"],
    route: "elbow",
    edgeStyle: { dash: "4 2" },
  } as unknown as Shape);
  return { bid, n1, n2, e };
}

const expectNodeExtras = (s: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(NODE_EXTRA)) expect(s[k], k).toEqual(v);
};

describe("an older client keeps fields it does not understand", () => {
  it("text edit, move, resize, group and z-order keep every new field (synced both ways)", () => {
    const [nw, old] = pair();
    const { bid, n1, n2 } = seed(nw);
    updateShape(old, bid, n1, { text: "Order line", fill: "blue" }, ORIGIN);
    moveShapes(old, bid, [{ id: n1, patch: { x: 40, y: 30 } }], ORIGIN);
    updateShape(old, bid, n1, { w: 220, h: 140 }, ORIGIN);
    setGroup(old, bid, [n1, n2], "", ORIGIN);
    setGroup(old, bid, [n1, n2], null, ORIGIN);
    bringToFront(old, bid, n1, ORIGIN);
    reorderShapes(old, bid, [n1], "back", ORIGIN);
    for (const d of [nw, old]) {
      const s = byId(d, bid, n1);
      expectNodeExtras(s);
      expect(s).toMatchObject({ text: "Order line", fill: "blue", x: 40, y: 30, w: 220, h: 140 });
    }
  });

  it("clearing one key (patch value undefined) deletes only that key", () => {
    const [nw, old] = pair();
    const { bid, n1 } = seed(nw);
    updateShape(old, bid, n1, { fill: "blue" }, ORIGIN);
    updateShape(old, bid, n1, { fill: undefined }, ORIGIN);
    const s = byId(nw, bid, n1);
    expect(s.fill).toBeUndefined();
    expectNodeExtras(s);
  });

  it("duplicate keeps the new node fields on the copy", () => {
    const [nw, old] = pair();
    const { bid, n1 } = seed(nw);
    const copy = duplicateShape(old, bid, shapesOf(old, bid).find((s) => s.id === n1)!, 24, 24, ORIGIN);
    const s = byId(nw, bid, copy);
    expectNodeExtras(s);
    expect(s).toMatchObject({ x: 24, y: 24, text: "Order" });
  });

  // v0.1.1's paste rebuilt bindings as `{shapeId, anchor}` (seen failing first, DGM-07), so a
  // 0.1.1 client still drops `port` here and the copy falls back to its `anchor`. That is why
  // writers must always keep `anchor` next to `port` (ADR-045). Fixed for current clients.
  it("copy and paste keeps node fields and the binding's port refinement", () => {
    const [nw, old] = pair();
    const { bid, n1, n2, e } = seed(nw);
    const picked = shapesOf(old, bid).filter((s) => [n1, n2, e].includes(s.id));
    const copies = cloneShapes(picked, 30, 30);
    insertShapes(old, bid, copies, ORIGIN);
    const all = shapesOf(nw, bid);
    const cn1 = all.find((s) => s.id === copies[0].id) as Shape & Record<string, unknown>;
    const ce = all.find((s) => s.id === copies[2].id) as Shape & Record<string, unknown>;
    expectNodeExtras(cn1);
    expect(ce.edgeStyle).toEqual({ dash: "4 2" });
    expect(ce.start).toEqual({ shapeId: copies[0].id, anchor: "right", port: "out" });
    expect(ce.end).toEqual({ shapeId: copies[1].id, anchor: "left", portx: { future: 1 } });
  });

  it("moving a bound node re-syncs the connector's pts but keeps its bindings and extra fields", () => {
    const [nw, old] = pair();
    const { bid, n1, e } = seed(nw);
    const s = shapesOf(old, bid).find((q) => q.id === n1)!;
    moveShapes(old, bid, [{ id: n1, patch: movePatch(s, 0, 200) }], ORIGIN);
    syncBoundArrows(old, bid, ORIGIN);
    const a = byId(nw, bid, e);
    expect(a.start).toEqual({ shapeId: n1, anchor: "right", port: "out" });
    expect(a.end).toMatchObject({ portx: { future: 1 } });
    expect(a.edgeStyle).toEqual({ dash: "4 2" });
    // Older clients draw a port binding at its legacy anchor: right side of the moved node.
    expect(a.pts![0]).toEqual([160, 250]);
  });

  it("undo and redo of an older client's edit keep the new fields", () => {
    const [nw, old] = pair();
    const { bid, n1 } = seed(nw);
    const um = new Y.UndoManager(getBoardMap(old, bid)!, { trackedOrigins: new Set([ORIGIN]), captureTimeout: 0 });
    updateShape(old, bid, n1, { text: "Changed" }, ORIGIN);
    um.undo();
    expectNodeExtras(byId(nw, bid, n1));
    expect(byId(nw, bid, n1).text).toBe("Order");
    um.redo();
    expectNodeExtras(byId(nw, bid, n1));
    expect(byId(nw, bid, n1).text).toBe("Changed");
  });

  it("deleting another shape leaves the new fields alone", () => {
    const [nw, old] = pair();
    const { bid, n1, n2 } = seed(nw);
    deleteShape(old, bid, n2, ORIGIN);
    expectNodeExtras(byId(nw, bid, n1));
  });

  it("concurrent: the newer client edits props while the older one moves the node; both survive", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const { bid, n1 } = seed(a);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Offline at the same time:
    updateShape(a, bid, n1, { props: { stereotype: "value" } });
    moveShapes(b, bid, [{ id: n1, patch: { x: 999 } }], ORIGIN);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) expect(byId(d, bid, n1)).toMatchObject({ x: 999, props: { ...NODE_EXTRA.props, stereotype: "value" }, kind: "uml:class" });
    // Stored per field.
    expect((getBoardMap(a, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).get(n1)!.get("props")).toBeInstanceOf(Y.Map);
  });

  // ADR-045 (owner condition, 2026-11-24): `props` merges per field. Phase 1 stored it as one
  // plain value, so the second writer's object replaced the first (seen failing first).
  it("concurrent edits to different props of one shape both survive the merge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const { bid, n1 } = seed(a);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    updateShape(a, bid, n1, { props: { stereotype: "value" } });
    updateShape(b, bid, n1, { props: { owner: "team-b", nested: { deep: [9], extra: { k: true } } } });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      expect(byId(d, bid, n1).props).toEqual({
        stereotype: "value",
        owner: "team-b",
        attrs: NODE_EXTRA.props.attrs,
        nested: { deep: [9], extra: { k: true } },
      });
    }
    // One field removed (undefined) leaves the others.
    updateShape(a, bid, n1, { props: { owner: undefined } });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(byId(b, bid, n1).props).not.toHaveProperty("owner");
    expect(byId(b, bid, n1).props).toHaveProperty("stereotype", "value");
  });

  it("props in the plain form (a 0.1.x copy) are read, and merge per field once edited", () => {
    const [nw, old] = pair();
    const { bid, n1 } = seed(nw);
    const copy = duplicateShape(old, bid, shapesOf(old, bid).find((s) => s.id === n1)!, 0, 0, ORIGIN);
    // Simulate a 0.1.x writer: props as one plain value.
    (getBoardMap(old, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).get(copy)!.set("props", { stereotype: "plain" });
    expect(byId(nw, bid, copy).props).toEqual({ stereotype: "plain" });
    updateShape(nw, bid, copy, { props: { owner: "x" } });
    expect(byId(old, bid, copy).props).toEqual({ stereotype: "plain", owner: "x" });
    expect((getBoardMap(nw, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).get(copy)!.get("props")).toBeInstanceOf(Y.Map);
  });

  it("a nested Y type written by a newer client survives an older client's edits", () => {
    const [nw, old] = pair();
    const { bid, n1 } = seed(nw);
    const ym = new Y.Map<unknown>();
    (getBoardMap(nw, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).get(n1)!.set("meta", ym);
    ym.set("owner", "team-a");
    updateShape(old, bid, n1, { text: "x" }, ORIGIN);
    moveShapes(old, bid, [{ id: n1, patch: { x: 5 } }], ORIGIN);
    const live = (getBoardMap(nw, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).get(n1)!.get("meta");
    expect(live).toBeInstanceOf(Y.Map);
    expect((live as Y.Map<unknown>).get("owner")).toBe("team-a");
    // An older client's copy writes it as plain JSON, which readers accept as well.
    const copy = duplicateShape(old, bid, shapesOf(old, bid).find((s) => s.id === n1)!, 0, 0, ORIGIN);
    expect(byId(nw, bid, copy).meta).toEqual({ owner: "team-a" });
  });
});

describe("an unknown shape type (written by a newer client or a missing plugin)", () => {
  it("is read, edited, copied and bound to without loss or crash", () => {
    const [nw, old] = pair();
    const bid = createBoard(nw, "blank");
    const u = addShape(nw, bid, { type: "network:router" as Shape["type"], x: 10, y: 20, w: 80, h: 60, text: "R1", props: { model: "x9" } } as unknown as Shape);
    const n = addShape(nw, bid, { type: "rect", x: 300, y: 20, w: 80, h: 60 });
    const e = addShape(nw, bid, { type: "arrow", pts: [[90, 50], [300, 50]], start: { shapeId: u, anchor: "right" }, end: { shapeId: n, anchor: "left" } });
    updateShape(old, bid, u, { text: "R2" }, ORIGIN);
    moveShapes(old, bid, [{ id: u, patch: { x: 50 } }], ORIGIN);
    syncBoundArrows(old, bid, ORIGIN);
    const copies = cloneShapes(shapesOf(old, bid).filter((s) => s.id === u), 10, 10);
    insertShapes(old, bid, copies, ORIGIN);
    const s = byId(nw, bid, u);
    expect(s).toMatchObject({ type: "network:router", text: "R2", x: 50, props: { model: "x9" } });
    expect(byId(nw, bid, copies[0].id)).toMatchObject({ type: "network:router", props: { model: "x9" } });
    expect(byId(nw, bid, e).pts![0]).toEqual([130, 50]);
    const all = withResolvedArrows(shapesOf(nw, bid));
    expect(all).toHaveLength(4);
  });
});

describe("orphan edges (concurrent delete and bind)", () => {
  it("an edge bound to a node deleted concurrently keeps drawing from its stored pts", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const bid = createBoard(a, "blank");
    const n1 = addShape(a, bid, { type: "rect", x: 0, y: 0, w: 100, h: 100 });
    const n2 = addShape(a, bid, { type: "rect", x: 300, y: 0, w: 100, h: 100 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    deleteShape(a, bid, n2, ORIGIN);
    const e = addShape(b, bid, { type: "arrow", pts: [[100, 50], [300, 50]], start: { shapeId: n1, anchor: "right" }, end: { shapeId: n2, anchor: "left" } }, ORIGIN);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      const list = shapesOf(d, bid);
      expect(list.map((s) => s.id).sort()).toEqual([n1, e].sort());
      const arrow = list.find((s) => s.id === e)!;
      // Binding kept (the node may come back with undo); the free end uses the stored point.
      expect(arrow.end).toEqual({ shapeId: n2, anchor: "left" });
      expect(resolveArrow(arrow, new Map(list.map((s) => [s.id, s])))).toEqual([[100, 50], [300, 50]]);
    }
  });
});
