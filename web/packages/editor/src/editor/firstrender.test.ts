// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// PSYNC-BUG-3: the editor renders the Yjs document once, when `renderContent` runs (after the
// node views are set), and never writes the empty document it starts with back into Yjs.
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { BASE_EXTENSIONS } from "./base";
import { BlockId } from "./blockId";
import { deferFirstRender, renderContent } from "./firstrender";

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function doc(n: number): Y.Doc {
  const d = new Y.Doc();
  d.getXmlFragment("content").insert(
    0,
    Array.from({ length: n }, (_, i) => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(`Block ${i}`)]);
      return p;
    }),
  );
  return d;
}

function mount(d: Y.Doc) {
  const e = new Editor({
    element: document.createElement("div"),
    extensions: [...BASE_EXTENSIONS, BlockId, Collaboration.configure({ document: d, field: "content", ySyncOptions: deferFirstRender() })],
  });
  editors.push(e);
  return e;
}

describe("one first render (PSYNC-BUG-3)", () => {
  it("renders the document when asked, and never writes the empty start into Yjs", async () => {
    const d = doc(30);
    const e = mount(d);
    // Not rendered yet: an empty document, and Yjs untouched (also after the id pass is due).
    expect(e.state.doc.textContent).toBe("");
    await new Promise((r) => setTimeout(r, 40));
    expect(d.getXmlFragment("content").length).toBe(30);
    renderContent(e);
    expect(e.state.doc.childCount).toBe(30);
    expect(e.state.doc.child(29).textContent).toBe("Block 29");
    // Edits and remote changes work as usual afterwards.
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    e.commands.insertContent("!");
    expect(d.getXmlFragment("content").toArray().at(-1)?.toString()).toContain("Block 29!");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("Remote")]);
    d.getXmlFragment("content").insert(0, [p]);
    expect(e.state.doc.child(0).textContent).toBe("Remote");
  });

  it("renders a remote change that arrives before the first render", () => {
    const d = doc(3);
    const e = mount(d);
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("Early")]);
    d.getXmlFragment("content").insert(3, [p]);
    renderContent(e);
    expect(e.state.doc.childCount).toBe(4);
    expect(e.state.doc.child(3).textContent).toBe("Early");
  });
});
