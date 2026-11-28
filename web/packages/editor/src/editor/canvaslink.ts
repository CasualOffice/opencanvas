// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// LINK-01 (ADR-081): the `canvasLink` inline node `{fileId, targetBlockId?, rowId?, label}`.
// Part of the schema from the first frame (a document with links parses the same with the
// feature on or off); everything else about links (the `[[` picker, titles from the host,
// previews, "Linked from") is the lazy `links/` chunk. The view shows the host's current
// title from `linkInfo` once that chunk has resolved it, else the saved label.
import { Node, mergeAttributes } from "@tiptap/core";
import { createStore } from "../lib/store";

/** What a link shows now (filled by `links/`): `ok`, `none` (no access), `gone`, `missing`. */
export interface LinkInfo {
  state: "ok" | "none" | "gone" | "missing";
  title?: string;
  block?: string;
}

/** `fileId` or `fileId#block` → what the host said. */
export const linkInfo = createStore<ReadonlyMap<string, LinkInfo>>(new Map());

export const linkKey = (fileId: string, block?: string | null) => (block ? `${fileId}#${block}` : fileId);

/** The text a link shows: the host's title (and block), or the saved label. */
export function linkText(attrs: Record<string, unknown>, info: LinkInfo | undefined): string {
  const label = String(attrs.label || "") || "Canvas";
  if (!info) return label;
  if (info.state === "none") return "No access";
  const title = info.title || label;
  return info.block ? `${title} › ${info.block}` : title;
}

export const CanvasLink = Node.create({
  name: "canvasLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    fileId: { default: "" },
    targetBlockId: { default: null },
    rowId: { default: null },
    label: { default: "" },
  }),
  parseHTML: () => [{ tag: "a[data-canvas-link]", getAttrs: (el) => ({ fileId: (el as HTMLElement).getAttribute("data-file") || "", targetBlockId: (el as HTMLElement).getAttribute("data-block"), label: (el as HTMLElement).textContent || "" }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["a", mergeAttributes(HTMLAttributes, { "data-canvas-link": "", "data-file": node.attrs.fileId, "data-block": node.attrs.targetBlockId, class: "clink" }), String(node.attrs.label || "Canvas")],
  renderText: ({ node }) => String(node.attrs.label || ""),
  addNodeView: () => ({ node }) => {
    const a = document.createElement("a");
    a.className = "clink";
    a.setAttribute("data-canvas-link", "");
    a.setAttribute("role", "link");
    a.contentEditable = "false";
    let attrs = node.attrs;
    const draw = () => {
      const block = attrs.targetBlockId || attrs.rowId;
      const info = linkInfo.get().get(linkKey(attrs.fileId, block)) ?? undefined;
      a.dataset.file = attrs.fileId;
      if (block) a.dataset.block = block;
      else delete a.dataset.block;
      a.dataset.state = info?.state ?? "";
      a.textContent = linkText(attrs, info);
    };
    draw();
    const off = linkInfo.subscribe(draw);
    return {
      dom: a,
      update: (n) => {
        if (n.type.name !== "canvasLink") return false;
        attrs = n.attrs;
        draw();
        return true;
      },
      destroy: off,
      ignoreMutation: () => true,
    };
  },
});
