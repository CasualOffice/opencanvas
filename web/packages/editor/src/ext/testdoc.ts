// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Test-only: a document with an SDK block, as a newer client or the server writes it (BSDK-05
// tests). Not imported by the app, so not in any bundle.
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { writeExtData } from "./model";
import { ExtBlock } from "./node";
import { BASE_EXTENSIONS } from "../editor/base";
import { BlockId } from "../editor/blockId";

/** A document a newer client (or the server) wrote: text, an SDK block with children, data. */
export function seedDoc(schema = getSchema([...BASE_EXTENSIONS, BlockId, ExtBlock])) {
  const doc = new Y.Doc();
  const json = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { blockId: "b_p" }, content: [{ type: "text", text: "Before" }] },
      {
        type: "extBlock",
        attrs: {
          blockId: "b_ext", type: "acme.okr", v: 2,
          attrs: { objective: "Ship v0.2", progress: 0.4, krs: [{ title: "API", done: true }] },
          dataId: "d_1", fallback: { markdown: "**Ship v0.2** (40%)", text: "Ship v0.2" },
        },
        content: [{ type: "paragraph", attrs: { blockId: "b_child" }, content: [{ type: "text", text: "Child" }] }],
      },
      { type: "paragraph", attrs: { blockId: "b_q" }, content: [{ type: "text", text: "After" }] },
    ],
  };
  prosemirrorJSONToYXmlFragment(schema, json, doc.getXmlFragment("content"));
  writeExtData(doc, "d_1", { score: 3, notes: { deep: [1, 2] } });
  return doc;
}

type Tree = { tag: string; attrs: Record<string, unknown>; children: (Tree | string)[] };
function tree(n: Y.XmlElement | Y.XmlFragment): Tree {
  return {
    tag: n instanceof Y.XmlElement ? n.nodeName : "#root",
    attrs: n instanceof Y.XmlElement ? n.getAttributes() : {},
    children: n.toArray().map((c) => (c instanceof Y.XmlText ? c.toString() : tree(c as Y.XmlElement))),
  };
}
export const snapshot = (doc: Y.Doc) => ({ content: JSON.stringify(tree(doc.getXmlFragment("content"))), ext: doc.getMap("ext").toJSON() });

