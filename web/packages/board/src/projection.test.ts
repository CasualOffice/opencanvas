// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// DGM-05: the incremental projection must equal `readShapes` after any change, re-read only the
// shapes a transaction touched, and keep unchanged shapes (and an unchanged list) as the same
// objects.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addShape, boardsRoot, bringToFront, createBoard, deleteShape, getBoardMap, moveShapes, readShapes, updateShape, type Shape } from "./model";
import { reorderShapes } from "./ops";
import { BoardProjection } from "./projection";
import { makeFixture, rng } from "../bench/fixtures";

const read = (doc: Y.Doc, id: string) => {
  const m = getBoardMap(doc, id);
  return m ? readShapes(m) : null;
};

function live(doc: Y.Doc, id: string) {
  const p = new BoardProjection(doc, id);
  let calls = 0;
  const off = p.subscribe(() => calls++);
  return { p, off, calls: () => calls };
}

describe("BoardProjection", () => {
  it("equals readShapes after every kind of change", () => {
    const doc = new Y.Doc();
    const bid = createBoard(doc, "flowchart");
    const { p } = live(doc, bid);
    const check = () => expect(p.get()).toEqual(read(doc, bid));
    check();
    const a = addShape(doc, bid, { type: "rect", x: 1, y: 2, w: 3, h: 4 });
    check();
    updateShape(doc, bid, a, { text: "hi", fill: "blue" });
    check();
    // Per-field props (a nested Y.Map): creating it, then editing one property inside it.
    updateShape(doc, bid, a, { props: { stereotype: "entity", n: 1 } });
    check();
    updateShape(doc, bid, a, { props: { n: 2 } });
    check();
    expect(p.get()!.find((s) => s.id === a)!.props).toEqual({ stereotype: "entity", n: 2 });
    moveShapes(doc, bid, [{ id: a, patch: { x: 50 } }]);
    check();
    bringToFront(doc, bid, read(doc, bid)![0].id);
    check();
    reorderShapes(doc, bid, [a], "back");
    check();
    // A shape missing from `order` comes after the ordered ones, by id.
    (getBoardMap(doc, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).set("zz-orphan", new Y.Map([["type", "rect"]]) as Y.Map<unknown>);
    (getBoardMap(doc, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).set("aa-orphan", new Y.Map([["type", "text"]]) as Y.Map<unknown>);
    check();
    // Duplicated ids in `order` and order entries without a shape are skipped.
    (getBoardMap(doc, bid)!.get("order") as Y.Array<string>).push([a, "missing"]);
    check();
    // A non-map value under shapes is ignored.
    (getBoardMap(doc, bid)!.get("shapes") as Y.Map<unknown>).set("junk", 5);
    check();
    deleteShape(doc, bid, a);
    check();
    // Nested Y types inside a shape.
    const nested = new Y.Map<unknown>();
    (getBoardMap(doc, bid)!.get("shapes") as Y.Map<Y.Map<unknown>>).get("aa-orphan")!.set("meta", nested);
    check();
    nested.set("k", 1);
    check();
    // `shapes` and `order` replaced wholesale.
    doc.transact(() => {
      getBoardMap(doc, bid)!.set("shapes", new Y.Map());
      getBoardMap(doc, bid)!.set("order", new Y.Array());
    });
    check();
    addShape(doc, bid, { type: "sticky", x: 0, y: 0, w: 10, h: 10 });
    check();
    // The whole board replaced, then removed.
    boardsRoot(doc).set(bid, new Y.Map());
    check();
    addShape(doc, bid, { type: "sticky", x: 0, y: 0, w: 10, h: 10 });
    check();
    boardsRoot(doc).delete(bid);
    expect(p.get()).toBeNull();
  });

  it("matches readShapes under random local and remote edits (fuzz)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const { doc, boardId } = makeFixture({ nodes: 40, seed });
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      const { p } = live(doc, boardId);
      expect(p.get()).toEqual(read(doc, boardId));
      for (let step = 0; step < 60; step++) {
        const d = r() < 0.5 ? doc : peer;
        const ids = read(d, boardId)!.map((s) => s.id);
        const pick = () => ids[Math.floor(r() * ids.length)];
        const op = Math.floor(r() * 7);
        if (op === 0) addShape(d, boardId, { type: "rect", x: r() * 500, y: r() * 500, w: 40, h: 40 });
        else if (op === 1 && ids.length) deleteShape(d, boardId, pick());
        else if (op === 2 && ids.length) updateShape(d, boardId, pick(), { text: "t" + step });
        else if (op === 3 && ids.length) moveShapes(d, boardId, [{ id: pick(), patch: { x: step } }, { id: pick(), patch: { y: step } }]);
        else if (op === 4 && ids.length) reorderShapes(d, boardId, [pick()], (["front", "back", "forward", "backward"] as const)[step % 4]);
        else if (op === 5 && ids.length) updateShape(d, boardId, pick(), { pts: [[step, 1], [2, step]] });
        else if (op === 6 && ids.length) {
          // Same value written again: an event, but nothing changed.
          const s = (getBoardMap(d, boardId)!.get("shapes") as Y.Map<Y.Map<unknown>>).get(pick());
          s?.set("type", s.get("type"));
        }
        // Sync now and then (so both sides see concurrent edits merge).
        if (r() < 0.4) {
          Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
        }
        expect(p.get(), `seed ${seed} step ${step}`).toEqual(read(doc, boardId));
      }
    }
  });

  it("re-reads only the shapes a transaction touched", () => {
    const { doc, boardId, nodeIds } = makeFixture({ nodes: 1000, seed: 3 });
    const { p } = live(doc, boardId);
    p.get();
    const before = p.stats.reads;
    moveShapes(doc, boardId, [{ id: nodeIds[5], patch: { x: 1 } }, { id: nodeIds[9], patch: { x: 2 } }]);
    p.get();
    expect(p.stats.reads - before).toBe(2);
  });

  it("keeps unchanged shapes, and an unchanged list, as the same objects", () => {
    const { doc, boardId, nodeIds } = makeFixture({ nodes: 50, seed: 4 });
    const { p, calls } = live(doc, boardId);
    const a = p.get()!;
    moveShapes(doc, boardId, [{ id: nodeIds[1], patch: { x: 999 } }]);
    const b = p.get()!;
    expect(b).not.toBe(a);
    expect(calls()).toBe(1);
    b.forEach((s, i) => (s.id === nodeIds[1] ? expect(s).not.toBe(a[i]) : expect(s).toBe(a[i])));
    // A write of the same value: an event, but the snapshot stays the same array.
    const y = (getBoardMap(doc, boardId)!.get("shapes") as Y.Map<Y.Map<unknown>>).get(nodeIds[2])!;
    y.set("text", y.get("text"));
    expect(p.get()).toBe(b);
    // A pure reorder keeps every shape object.
    bringToFront(doc, boardId, nodeIds[0]);
    const c = p.get()!;
    expect(c).not.toBe(b);
    expect(new Set(c)).toEqual(new Set(b));
  });

  it("ignores transactions outside its board", () => {
    const { doc, boardId } = makeFixture({ nodes: 10, seed: 5 });
    const other = createBoard(doc, "flow");
    const { p, calls } = live(doc, boardId);
    const a = p.get();
    updateShape(doc, other, read(doc, other)![0].id, { text: "x" });
    doc.getText("t").insert(0, "x");
    expect(calls()).toBe(0);
    expect(p.get()).toBe(a);
  });

  it("notices a board created after the projection, and changes made while unsubscribed", () => {
    const doc = new Y.Doc();
    const p = new BoardProjection(doc, "late");
    const off = p.subscribe(() => {});
    expect(p.get()).toBeNull();
    doc.transact(() => {
      const m = new Y.Map<unknown>();
      boardsRoot(doc).set("late", m);
      m.set("shapes", new Y.Map());
      m.set("order", new Y.Array());
    });
    addShape(doc, "late", { type: "rect", x: 0, y: 0, w: 1, h: 1 } as Shape);
    expect(p.get()).toEqual(read(doc, "late"));
    off();
    addShape(doc, "late", { type: "text", x: 0, y: 0, text: "while away" });
    const off2 = p.subscribe(() => {});
    expect(p.get()).toEqual(read(doc, "late"));
    off2();
  });
});
