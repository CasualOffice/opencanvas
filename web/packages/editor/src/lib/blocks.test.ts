// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bridge } from "./bridge";
import { blockDoc, blockMap, eachBlock, observeBlocks } from "./blocks";
import { PartsClient } from "./parts";

function withBlock(doc: Y.Doc, id: string, name: string) {
  const m = new Y.Map<unknown>();
  doc.getMap("databases").set(id, m);
  m.set("name", name);
  return m;
}

afterEach(() => {
  bridge.doc = undefined as unknown as Y.Doc;
  bridge.parts = null;
});

describe("block accessor (PSYNC-03)", () => {
  it("reads a split room's blocks from their parts and new blocks from the main document", () => {
    const main = new Y.Doc();
    withBlock(main, "d_new", "Made since the split");
    const parts = new PartsClient("doc_1", { send: () => false, sendControl: () => undefined });
    parts.setParts([{ id: "doc_1/block/d1", kind: "database" }, { id: "doc_1/block/d2", kind: "database" }]);
    const d1 = parts.acquire("d1");
    withBlock(d1, "d1", "Tasks");
    bridge.doc = main;
    bridge.parts = parts;

    expect(blockMap(main, "databases", "d1")?.get("name")).toBe("Tasks");
    expect(blockDoc(main, "d1")).toBe(d1);
    expect(blockMap(main, "databases", "d_new")?.get("name")).toBe("Made since the split");
    expect(blockDoc(main, "d_new")).toBe(main);
    // d2 is a part not loaded: not there yet.
    expect(blockMap(main, "databases", "d2")).toBeUndefined();
    const names: string[] = [];
    eachBlock(main, "databases", (m) => names.push(String(m.get("name"))));
    expect(names.sort()).toEqual(["Made since the split", "Tasks"]);

    // Changes in a part, and in a part loaded later, reach observers.
    const fn = vi.fn();
    const off = observeBlocks(main, "databases", fn);
    fn.mockClear();
    blockMap(main, "databases", "d1")!.set("name", "Renamed");
    expect(fn).toHaveBeenCalled();
    const d2 = parts.acquire("d2");
    fn.mockClear();
    withBlock(d2, "d2", "Bugs");
    expect(fn).toHaveBeenCalled();
    off();
    fn.mockClear();
    blockMap(main, "databases", "d1")!.set("name", "Again");
    expect(fn).not.toHaveBeenCalled();
  });

  it("reads the main document when the room is not split", () => {
    const main = new Y.Doc();
    withBlock(main, "d1", "Tasks");
    bridge.doc = main;
    bridge.parts = new PartsClient("doc_1", { send: () => false, sendControl: () => undefined });
    expect(blockMap(main, "databases", "d1")?.get("name")).toBe("Tasks");
  });
});
