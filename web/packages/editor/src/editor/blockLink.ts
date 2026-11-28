// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// "Copy link to block" and, for a shape on a board, "Copy link to shape" (BRD-21, board UX
// decision 1). The host owns URLs (docs/05 §4): it gets the ids (`UI_BlockLink`) and builds its
// own link; the clipboard gets the editor's link (or the host's `[host.live] link`).
import { bridge } from "../lib/bridge";
import { postToHost } from "../lib/host";
import { toast } from "../lib/store";
import { copyBlockLink } from "../live/state";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The editor's own link to a block (and a shape on it): the demo's full URL, else the hash. */
export function blockLinkText(o: { demo: boolean; href: string; blockId: string; shapeId?: string }): string {
  const tail = `block=${o.blockId}${o.shapeId ? `&shape=${o.shapeId}` : ""}`;
  if (!o.demo) return `#${tail}`;
  const url = new URL(o.href);
  url.hash = "";
  return `${url.toString()}#demo&${tail}`;
}

/** The block and shape a deep link names (`#…&block=<id>&shape=<id>`); ids outside `[A-Za-z0-9_-]{1,64}` are dropped. */
export function linkTarget(hash: string): { blockId: string | null; shapeId: string | null } {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const ok = (v: string | null) => (v && ID.test(v) ? v : null);
  return { blockId: ok(q.get("block")), shapeId: ok(q.get("shape")) };
}

/** Tells the host and copies the link to a block, or to a shape on a board block. */
export function copyLinkTo(blockId: string, shapeId?: string) {
  const fileId = bridge.session?.file?.id ?? null;
  const values: Record<string, unknown> = { fileId, blockId, ...(shapeId ? { shapeId } : {}) };
  postToHost("UI_BlockLink", values);
  // `UI_Block_Link` is the name hosts built against first.
  postToHost("UI_Block_Link", values);
  const demo = !!bridge.session?.demo;
  const link = blockLinkText({ demo, href: window.location.href, blockId, shapeId });
  // With the editor's marker, so pasting it in another canvas offers a reference (1d).
  if (fileId && !demo) void copyBlockLink({ fileId, blockId, shapeId }, link);
  else void navigator.clipboard?.writeText(link).catch(() => undefined);
  const what = shapeId ? "shape" : "block";
  toast(demo ? `Link to ${what} copied` : `${shapeId ? "Shape" : "Block"} link copied. Paste it in a comment or a message.`, { icon: "link" });
}
