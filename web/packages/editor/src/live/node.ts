// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Portable live blocks in the schema (LIVE-02, ADR-039, docs/15 §4.4): `liveBlock {blockId,
// fileId, hostId, kind, title, snapshot, snapshotAt}` and `blockRef {blockId, fileId,
// refBlockId, title, snapshot, snapshotAt}`, both atoms. Schema only: y-prosemirror needs every
// client to know the nodes or it deletes them (ADR-059), and this editor says so with
// `caps=live`. There is no node view yet: the live block chrome waits for its approved prototype
// (LIVE-03, ADR-011), so a node renders as a plain, non-editable caption.
import { Node } from "@tiptap/core";

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
});
