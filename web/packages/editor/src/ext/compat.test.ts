// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// 0.1.x forward compatibility of SDK blocks (BSDK-05, ADR-042). A deployed 0.1.1 editor binds
// the shared document with y-prosemirror against its own schema (test-fixtures/v011, the
// schema-defining extensions at tag v0.1.1). That schema has no `extBlock`, and y-prosemirror
// deletes any node its schema cannot represent. So:
//   1. the 0.1.1 binding's only change is removing the `extBlock` elements: every other node,
//      attribute and the `ext` root are left as they were, and its own edits travel in
//      separate updates;
//   2. the server refuses an update that removes an `extBlock` from a connection without
//      `caps=ext` (crates/oc-server/tests/blocks.rs), modelled here by the same rule, so the
//      room keeps every block, attribute, child and data field after a 0.1.1 editor has loaded
//      and edited the document.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Y from "yjs";
import { Schema, type NodeSpec, type MarkSpec } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPlugin } from "@tiptap/y-tiptap";
import { seedDoc, snapshot } from "./testdoc";

const V011 = JSON.parse(readFileSync(resolve(__dirname, "../../test-fixtures/v011/schema.json"), "utf8")) as {
  topNode: string;
  nodes: [string, NodeSpec][];
  marks: [string, MarkSpec][];
};
/** The 0.1.1 specs with plain DOM output (the snapshot keeps structure, not rendering). */
const v011Schema = () =>
  new Schema({
    topNode: V011.topNode,
    nodes: Object.fromEntries(
      V011.nodes.map(([name, spec]) => {
        const tag = spec.inline ? "span" : "div";
        return [name, name === "text" ? spec : { ...spec, toDOM: () => (spec.content ? [tag, 0] : [tag]) }];
      }),
    ),
    marks: Object.fromEntries(V011.marks.map(([name, spec]) => [name, { ...spec, toDOM: () => ["span", 0] }])),
  });

/** Number of `extBlock` elements in the content tree. */
function extCount(doc: Y.Doc): number {
  let n = 0;
  const walk = (f: Y.XmlFragment | Y.XmlElement) => {
    for (const c of f.toArray()) {
      if (c instanceof Y.XmlElement) {
        if (c.nodeName === "extBlock") n++;
        walk(c);
      }
    }
  };
  walk(doc.getXmlFragment("content"));
  return n;
}

/** The server's rule (room filter `removes_ext_block`): applied to a scratch copy, an update
 *  from a connection without `caps=ext` may not lower the number of `extBlock`s. */
function serverAccepts(room: Y.Doc, update: Uint8Array): boolean {
  const before = extCount(room);
  if (before === 0) return true;
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(room));
  Y.applyUpdate(scratch, update);
  return extCount(scratch) >= before;
}

/** A 0.1.1 editor joining the room: syncs, renders with y-prosemirror, then edits. */
function oldEditorSession(room: Y.Doc) {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
  const updates: Uint8Array[] = [];
  client.on("update", (u: Uint8Array) => updates.push(u));
  const schema = v011Schema();
  expect(schema.nodes.extBlock, "0.1.1 has no extBlock").toBeUndefined();
  const view = new EditorView(document.createElement("div"), { state: EditorState.create({ schema, plugins: [ySyncPlugin(client.getXmlFragment("content"))] }) });
  return { client, view, updates };
}

describe("a 0.1.1 editor and SDK blocks", () => {
  it("removes only the extBlock (y-prosemirror) and leaves everything else as it was", () => {
    const room = seedDoc();
    const before = snapshot(room);
    const { client, view, updates } = oldEditorSession(room);
    expect(extCount(client)).toBe(0);
    expect(updates.length).toBeGreaterThan(0);
    // Everything else the 0.1.1 client holds is the room's content minus the block.
    expect(snapshot(client).ext).toEqual(before.ext);
    const text = view.state.doc.textContent;
    expect(text).toBe("BeforeAfter");
    view.destroy();
  });

  it("loses nothing in the room once the server refuses that removal", () => {
    const room = seedDoc();
    const before = snapshot(room);
    const { view, updates } = oldEditorSession(room);
    // The 0.1.1 person types; that edit is its own update.
    const loadUpdates = updates.length;
    view.dispatch(view.state.tr.insertText(" edited", view.state.doc.child(0).nodeSize - 1));
    const all = updates.slice();
    let refused = 0;
    for (const u of all) {
      if (serverAccepts(room, u)) Y.applyUpdate(room, u);
      else refused++;
    }
    expect(refused).toBe(loadUpdates);
    const after = snapshot(room);
    expect(extCount(room)).toBe(1);
    expect(after.ext).toEqual(before.ext);
    // The block with every attribute and its child is still in the room, byte for byte.
    expect(after.content).toEqual(before.content.replace("Before", "Before edited"));
    view.destroy();
  });

  it("without the server rule the block would be lost (why the rule exists)", () => {
    const room = seedDoc();
    const { view, updates } = oldEditorSession(room);
    for (const u of updates) Y.applyUpdate(room, u);
    expect(extCount(room)).toBe(0);
    view.destroy();
  });
});
