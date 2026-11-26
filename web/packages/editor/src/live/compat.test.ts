// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Mixed versions and live blocks (LIVE-02, ADR-059's rule for `liveBlock`/`blockRef`). A 0.2
// editor binds the shared document with y-prosemirror against a schema without these nodes,
// and y-prosemirror deletes any node its schema lacks, for every peer. So:
//   1. this editor's schema has both nodes, and binding it changes nothing in the room;
//   2. a 0.2 binding's only change is removing them (modelled with the 0.2 schema-defining
//      extensions: base, blockId, extBlock), and the server refuses that removal from a
//      connection without `caps=live` (crates/oc-server/tests/live_blocks.rs), modelled here by
//      the same rule, so the room keeps every node and attribute.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getSchema, type AnyExtension } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPlugin, prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { BASE_EXTENSIONS } from "../editor/base";
import { BlockId } from "../editor/blockId";
import { ExtBlock } from "../ext/node";
import { BlockRef, LiveBlock } from "./node";

const CURRENT: AnyExtension[] = [...BASE_EXTENSIONS, BlockId, ExtBlock, LiveBlock, BlockRef];
const V02: AnyExtension[] = [...BASE_EXTENSIONS, BlockId, ExtBlock];

function seed() {
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(getSchema(CURRENT), {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { blockId: "b_p" }, content: [{ type: "text", text: "Before" }] },
      { type: "liveBlock", attrs: { blockId: "b_live", fileId: "L1", hostId: "acme", kind: "board", title: "Q1 OKRs", snapshot: { markdown: "**kept**" }, snapshotAt: "2026-11-26T10:00:00Z" } },
      { type: "blockRef", attrs: { blockId: "b_ref", fileId: "F2", refBlockId: "b_src", title: "Status" } },
      { type: "paragraph", attrs: { blockId: "b_q" }, content: [{ type: "text", text: "After" }] },
    ],
  }, doc.getXmlFragment("content"));
  return doc;
}

const LIVE = new Set(["liveBlock", "blockRef"]);
function liveCount(doc: Y.Doc): number {
  let n = 0;
  const walk = (f: Y.XmlFragment | Y.XmlElement) => {
    for (const c of f.toArray()) {
      if (c instanceof Y.XmlElement) {
        if (LIVE.has(c.nodeName)) n++;
        walk(c);
      }
    }
  };
  walk(doc.getXmlFragment("content"));
  return n;
}

/** The server's rule (room filter `live_check`) for a connection without `caps=live`. */
function serverAccepts(room: Y.Doc, update: Uint8Array): boolean {
  const before = liveCount(room);
  if (before === 0) return true;
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(room));
  Y.applyUpdate(scratch, update);
  return liveCount(scratch) >= before;
}

function bind(room: Y.Doc, exts: AnyExtension[]) {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
  const updates: Uint8Array[] = [];
  client.on("update", (u: Uint8Array) => updates.push(u));
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ schema: getSchema(exts), plugins: [ySyncPlugin(client.getXmlFragment("content"))] }),
  });
  return { client, view, updates };
}

const tree = (doc: Y.Doc) => doc.getXmlFragment("content").toJSON();

describe("live blocks across editor versions", () => {
  it("this editor keeps both nodes with every attribute", () => {
    const room = seed();
    const before = tree(room);
    const { client, view, updates } = bind(room, CURRENT);
    for (const u of updates) Y.applyUpdate(room, u);
    expect(liveCount(client)).toBe(2);
    expect(tree(room)).toEqual(before);
    const live = view.state.doc.child(1);
    expect(live.type.name).toBe("liveBlock");
    expect(live.attrs).toMatchObject({ fileId: "L1", hostId: "acme", kind: "board", title: "Q1 OKRs", snapshot: { markdown: "**kept**" } });
    expect(view.state.doc.child(2).attrs).toMatchObject({ fileId: "F2", refBlockId: "b_src" });
    view.destroy();
  });

  it("a 0.2 editor deletes them, and the server refusing that loses nothing", () => {
    const room = seed();
    const before = tree(room);
    const { client, view, updates } = bind(room, V02);
    expect(getSchema(V02).nodes.liveBlock, "0.2 has no liveBlock").toBeUndefined();
    expect(liveCount(client)).toBe(0);
    const loadUpdates = updates.length;
    expect(loadUpdates).toBeGreaterThan(0);
    // The 0.2 person types; that edit is its own update.
    view.dispatch(view.state.tr.insertText(" edited", view.state.doc.child(0).nodeSize - 1));
    let refused = 0;
    for (const u of updates) {
      if (serverAccepts(room, u)) Y.applyUpdate(room, u);
      else refused++;
    }
    expect(refused).toBe(loadUpdates);
    expect(liveCount(room)).toBe(2);
    expect(JSON.stringify(tree(room))).toBe(JSON.stringify(before).replace("Before", "Before edited"));
    view.destroy();
  });

  it("without the server rule they would be lost (why the rule exists)", () => {
    const room = seed();
    const { view, updates } = bind(room, V02);
    for (const u of updates) Y.applyUpdate(room, u);
    expect(liveCount(room)).toBe(0);
    view.destroy();
  });
});
