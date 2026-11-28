// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// LINK-A5: an editor whose schema has no `canvasLink` (0.4) opens a canvas that holds one.
// The binding drops what its schema cannot show, so the server guards the node (caps=links).
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { CanvasLink } from "../editor/canvaslink";

function docWithLink(): Y.Doc {
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, "See ");
  const link = new Y.XmlElement("canvasLink");
  link.setAttribute("fileId", "doc_9");
  link.setAttribute("label", "SSO rollout plan");
  p.insert(0, [t, link]);
  frag.insert(0, [p]);
  return ydoc;
}

const linksIn = (ydoc: Y.Doc) => ydoc.getXmlFragment("default").toString().match(/<canvaslink/gi)?.length ?? 0;

describe("0.4 round trip (LINK-A5)", () => {
  // Why the server refuses such an update from a connection without `caps=links`
  // (tests/links.rs `an_editor_older_than_0_5_cannot_delete_canvas_links`).
  it("an editor without the node deletes the link from the document", () => {
    const ydoc = docWithLink();
    const ed = new Editor({ extensions: [StarterKit.configure({ undoRedo: false } as never), Collaboration.configure({ document: ydoc })] });
    ed.commands.insertContentAt(1, "x");
    expect(linksIn(ydoc)).toBe(0);
    ed.destroy();
  });
  it("this editor shows it and keeps it", () => {
    const ydoc = docWithLink();
    const ed = new Editor({ extensions: [StarterKit.configure({ undoRedo: false } as never), Collaboration.configure({ document: ydoc }), CanvasLink] });
    expect(ed.getJSON().content?.[0].content?.[1]?.type).toBe("canvasLink");
    ed.commands.insertContentAt(1, "x");
    expect(linksIn(ydoc)).toBe(1);
    ed.destroy();
  });
});
