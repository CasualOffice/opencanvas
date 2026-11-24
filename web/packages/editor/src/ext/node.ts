// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The one generic node every SDK block is stored as (BSDK-02, ADR-040, docs/15 §4.2):
// `extBlock {blockId, type, v, attrs (JSON), dataId?, fallback}` with content `block*`. The
// schema is the same in every client whether or not it has the package, which y-prosemirror
// needs. Until the sandboxed runtime (BSDK-03) draws blocks, every block shows its stored
// fallback as plain text, read-only, in an unstyled container; nothing is rewritten, so all
// attributes, data and children round-trip. Visible elements: the fallback line, and the
// line "Updated by a newer version" for data newer than the installed package.
import { Node } from "@tiptap/core";
import { editable, fallbackText, statusOf, type ExtAttrs } from "./model";

const json = (s: string | null) => {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

export const ExtBlock = Node.create({
  name: "extBlock",
  group: "block",
  content: "block*",
  defining: true,
  isolating: true,
  draggable: true,
  addAttributes: () => ({
    type: { default: "", parseHTML: (el) => el.getAttribute("data-ext-type") ?? "", renderHTML: (a) => ({ "data-ext-type": a.type }) },
    v: { default: 1, parseHTML: (el) => Number(el.getAttribute("data-ext-v")) || 1, renderHTML: (a) => ({ "data-ext-v": String(a.v) }) },
    attrs: { default: null, parseHTML: (el) => json(el.getAttribute("data-ext-attrs")), renderHTML: (a) => (a.attrs ? { "data-ext-attrs": JSON.stringify(a.attrs) } : {}) },
    dataId: { default: null, parseHTML: (el) => el.getAttribute("data-ext-data"), renderHTML: (a) => (a.dataId ? { "data-ext-data": a.dataId } : {}) },
    fallback: { default: null, parseHTML: (el) => json(el.getAttribute("data-ext-fallback")), renderHTML: (a) => (a.fallback ? { "data-ext-fallback": JSON.stringify(a.fallback) } : {}) },
  }),
  parseHTML: () => [{ tag: 'div[data-type="extBlock"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, "data-type": "extBlock" }, 0],
  renderText: ({ node }) => fallbackText(node.attrs as ExtAttrs),
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "oc-ext";
      dom.dataset.type = "extBlock";
      const head = document.createElement("div");
      head.className = "oc-ext-fallback";
      head.contentEditable = "false";
      const children = document.createElement("div");
      children.className = "oc-ext-children";
      dom.append(head, children);
      let current = node;
      const draw = () => {
        const a = current.attrs as ExtAttrs;
        const s = statusOf(a);
        dom.dataset.extType = a.type;
        dom.dataset.extStatus = s;
        head.replaceChildren();
        if (s === "newer") {
          const note = document.createElement("div");
          note.className = "oc-ext-note";
          note.textContent = "Updated by a newer version";
          head.append(note);
        }
        const text = document.createElement("div");
        text.textContent = fallbackText(a);
        head.append(text);
        // Children of a block nobody here can draw (or from a newer version) stay as written.
        children.contentEditable = editable(s) ? "true" : "false";
        children.hidden = current.childCount === 0;
      };
      draw();
      return {
        dom,
        contentDOM: children,
        update: (n) => {
          if (n.type !== current.type) return false;
          current = n;
          draw();
          return true;
        },
        // The fallback line is not editable content; ProseMirror ignores changes inside it.
        ignoreMutation: (m) => head.contains(m.target as globalThis.Node),
        stopEvent: (e) => head.contains(e.target as globalThis.Node),
      };
    };
  },
});
