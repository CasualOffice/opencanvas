// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Portable live blocks in the schema (LIVE-02, ADR-039, docs/15 §4.4): `liveBlock {blockId,
// fileId, hostId, kind, title, snapshot, snapshotAt}` and `blockRef {blockId, fileId,
// refBlockId, title, snapshot, snapshotAt}`, both atoms. Schema only: y-prosemirror needs every
// client to know the nodes or it deletes them (ADR-059), and this editor says so with
// `caps=live`. The node views (LIVE-03, the approved prototype) load on demand: `view.tsx` is a
// small placeholder that pulls in `LiveView.tsx` the first time a canvas shows one.
import { Node } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { LiveStub, RefStub } from "./view";
import { postToHost } from "../lib/host";

/** The node view owns its events (the header, menus and the live block's own editor). */
const own = {
  stopEvent: ({ event }: { event: Event }) => {
    const t = event.target as HTMLElement | null;
    if (event.type.startsWith("drag") || event.type === "drop") return false;
    return !!t?.closest?.(".lb-h, .rf-h, .lb-b, .rf-b, .lb-na, .lb-st, .lb-hint");
  },
  ignoreMutation: () => true,
};

const json = (s: string | null) => {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

const str = (name: string, data: string) => ({
  default: "",
  parseHTML: (el: HTMLElement) => el.getAttribute(data) ?? "",
  renderHTML: (a: Record<string, unknown>) => (a[name] ? { [data]: String(a[name]) } : {}),
});

const snapshot = {
  default: null,
  parseHTML: (el: HTMLElement) => json(el.getAttribute("data-live-snapshot")),
  renderHTML: (a: Record<string, unknown>) => (a.snapshot ? { "data-live-snapshot": JSON.stringify(a.snapshot) } : {}),
};

const caption = (what: string, title: unknown) => {
  const t = typeof title === "string" ? title.trim() : "";
  return t ? `${what}: ${t}` : what;
};

export const LiveBlock = Node.create({
  name: "liveBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({
    fileId: str("fileId", "data-live-file"),
    hostId: str("hostId", "data-live-host"),
    kind: str("kind", "data-live-kind"),
    title: str("title", "data-live-title"),
    snapshot,
    snapshotAt: str("snapshotAt", "data-live-at"),
  }),
  parseHTML: () => [{ tag: 'div[data-type="liveBlock"]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    { ...HTMLAttributes, "data-type": "liveBlock", contenteditable: "false" },
    caption("Live block", node.attrs.title),
  ],
  renderText: ({ node }) => caption("Live block", node.attrs.title),
  addNodeView() {
    return ReactNodeViewRenderer(LiveStub, own);
  },
  addKeyboardShortcuts() {
    return {
      // Enter on a selected live block moves the caret into it.
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "liveBlock") return false;
        const dom = editor.view.nodeDOM(sel.from) as HTMLElement | null;
        const inner = dom?.querySelector<HTMLElement>(".lb-b .ProseMirror");
        if (!inner) return false;
        inner.focus();
        return true;
      },
    };
  },
});

export const BlockRef = Node.create({
  name: "blockRef",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({
    fileId: str("fileId", "data-ref-file"),
    refBlockId: str("refBlockId", "data-ref-block"),
    title: str("title", "data-ref-title"),
    snapshot,
    snapshotAt: str("snapshotAt", "data-ref-at"),
  }),
  parseHTML: () => [{ tag: 'div[data-type="blockRef"]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    { ...HTMLAttributes, "data-type": "blockRef", contenteditable: "false" },
    caption("Block reference", node.attrs.title),
  ],
  renderText: ({ node }) => caption("Block reference", node.attrs.title),
  addNodeView() {
    return ReactNodeViewRenderer(RefStub, own);
  },
  addKeyboardShortcuts() {
    return {
      // 3a: Enter on a selected reference opens the source canvas at that block.
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "blockRef") return false;
        postToHost("UI_LiveBlockOpen", { fileId: sel.node.attrs.fileId, blockId: sel.node.attrs.refBlockId });
        return true;
      },
    };
  },
});
