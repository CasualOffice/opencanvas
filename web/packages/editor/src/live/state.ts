// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Live blocks in the editor shell (LIVE-03, ADR-069, docs/prototypes/v03-approved/live-blocks.html).
// Kept small: it is in the first bundle. The chrome, the rooms and the dialogs load on demand
// (`LiveView.tsx`, `make.tsx`).
import type { Editor, Range } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { createStore, toast } from "../lib/store";
import { onHost, postToHost } from "../lib/host";

/** The session answer's `live` (docs/15 §2): what this person may do with live blocks here. */
export interface LiveCfg {
  enabled: boolean;
  make: boolean;
  insert: boolean;
  snapshot: "none" | "title" | "content";
  maxOpen: number;
  link: string | null;
}

export const OFF: LiveCfg = { enabled: false, make: false, insert: false, snapshot: "title", maxOpen: 8, link: null };
export const liveCfg = createStore<LiveCfg>(OFF);
/** The host did not answer `UI_PickLiveBlock` within 2 s: the insert entry hides for the session (1e). */
export const pickerGone = createStore(false);
/** `POST /files` answered 501: "Make live" hides for the session (docs/27 §9 decision 2). */
export const makeGone = createStore(false);

/** The "Make live" dialog (1b): for the block at `pos` (or the selection around it). */
export const makeStore = createStore<{ editor: Editor; pos: number; blockId?: string | null } | null>(null);

/** "Make live" shows in this editor: the host allows it, and it is not a live block's editor. */
export const canOfferMake = (editor: Editor) => liveCfg.get().make && !makeGone.get() && !nestedEditors.has(editor) && editor.isEditable;

export function setLiveCfg(c: Partial<LiveCfg> | null | undefined) {
  liveCfg.set(c ? { ...OFF, ...c, maxOpen: Math.max(1, Math.min(8, Number(c.maxOpen) || 8)) } : OFF);
}

/** A canvas holds at most this many live blocks and references (docs/15 §4.4). */
export const MAX_REFS = 50;
export const DEPTH_MSG = "Live blocks can’t contain other live blocks.";
export const LIMIT_MSG = "A canvas can hold up to 50 live blocks and references.";

/** Editors that show a live file inside a live block (no live blocks inside them: depth 1). */
export const nestedEditors = new WeakSet<object>();

export function countRefs(state: EditorState): number {
  let n = 0;
  state.doc.descendants((node) => {
    if (node.type.name === "liveBlock" || node.type.name === "blockRef") n++;
    return !node.isAtom;
  });
  return n;
}

/** The two refusals of frame 5g, before anything changes. */
export function mayAddRef(editor: Editor, adding = 1): boolean {
  if (nestedEditors.has(editor)) {
    toast(DEPTH_MSG, { icon: "triangle-alert" });
    return false;
  }
  if (countRefs(editor.state) + adding > MAX_REFS) {
    toast(LIMIT_MSG, { icon: "triangle-alert" });
    return false;
  }
  return true;
}

export { newBlockId } from "../editor/blockId";
import { newBlockId } from "../editor/blockId";

/** Inserts a `liveBlock` (or a `blockRef` when `refBlockId`) at `at` or the selection. */
export function insertRef(editor: Editor, a: { fileId: string; refBlockId?: string; title?: string }, at?: number | Range): string | null {
  if (!editor.isEditable || !mayAddRef(editor)) return null;
  const blockId = newBlockId();
  const title = liveCfg.get().snapshot === "none" ? "" : (a.title ?? "").slice(0, 200);
  const node = a.refBlockId
    ? { type: "blockRef", attrs: { blockId, fileId: a.fileId, refBlockId: a.refBlockId, title } }
    : { type: "liveBlock", attrs: { blockId, fileId: a.fileId, kind: "blocks", title } };
  let c = editor.chain().focus();
  if (at && typeof at === "object") c = c.deleteRange(at).insertContentAt(at.from, [node, { type: "paragraph" }]);
  else if (typeof at === "number") c = c.insertContentAt(at, [node, { type: "paragraph" }]);
  else c = c.insertContent([node, { type: "paragraph" }]);
  c.run();
  // The title the host's snapshot policy keeps is written by the server for this person.
  void import("./api").then((m) => m.refreshNode(blockId)).catch(() => undefined);
  return blockId;
}

// ---------- the host's picker (1e): UI_PickLiveBlock → Action_InsertLiveBlock ----------

let picking: { editor: Editor; pos: number; timer: number } | null = null;

/** "Live block" in the insert menu: the host shows its own picker. */
export function pickLiveBlock(editor: Editor, range: Range | null) {
  if (range) editor.chain().focus().deleteRange(range).run();
  if (!mayAddRef(editor)) return;
  if (picking) window.clearTimeout(picking.timer);
  const pos = editor.state.selection.from;
  const timer = window.setTimeout(() => {
    if (!picking) return;
    picking = null;
    pickerGone.set(true);
    toast("The live block picker didn’t open. Try again later.", { icon: "triangle-alert" });
  }, 2000);
  picking = { editor, pos, timer };
  postToHost("UI_PickLiveBlock", {});
}

/** Wires the host's answers once per page. */
export function installLiveHost(): () => void {
  const offs = [
    // The host opened (or cancelled) its picker: it answered, so it stays.
    onHost("Action_LiveBlockPicker", (v) => {
      if (!picking) return;
      window.clearTimeout(picking.timer);
      if (v.state === "cancel") picking = null;
    }),
    onHost("Action_InsertLiveBlock", (v) => {
      const p = picking;
      picking = null;
      if (p) window.clearTimeout(p.timer);
      const fileId = typeof v.fileId === "string" ? v.fileId.trim() : "";
      if (!p || !fileId || fileId.length > 1024) return;
      const pos = Math.min(p.pos, p.editor.state.doc.content.size);
      insertRef(p.editor, { fileId, title: typeof v.title === "string" ? v.title : undefined }, pos);
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------- block links (paste as, 1d) ----------

export interface BlockLink {
  fileId: string;
  blockId?: string;
  /** Known to be a live file (copied from a live block's menu). */
  live?: boolean;
}

/** What "Copy link" puts on the clipboard besides the host's URL text (read back by paste). */
export function linkHtml(url: string, l: BlockLink): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const attrs = [`data-oc-file="${esc(l.fileId)}"`, l.blockId ? `data-oc-block="${esc(l.blockId)}"` : "", l.live ? 'data-oc-live="1"' : ""].filter(Boolean).join(" ");
  return `<a href="${esc(url)}" ${attrs}>${esc(url)}</a>`;
}

const ID = /^[A-Za-z0-9_.:-]{1,1024}$/;

/** A pasted link that names a canvas file: the editor's own clipboard marker, or the host's
 *  `[host.live] link` pattern (`{fileId}`, optionally followed by `#block=<id>`). */
export function parseBlockLink(text: string, html: string | null, pattern: string | null): BlockLink | null {
  if (html && html.includes("data-oc-file")) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const a = doc.querySelector("[data-oc-file]");
    const fileId = a?.getAttribute("data-oc-file") ?? "";
    const blockId = a?.getAttribute("data-oc-block") ?? undefined;
    if (ID.test(fileId) && (!blockId || ID.test(blockId))) return { fileId, blockId, live: a?.getAttribute("data-oc-live") === "1" };
  }
  if (!pattern || !pattern.includes("{fileId}")) return null;
  const [pre, post] = pattern.split("{fileId}");
  const q = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${q(pre)}([^/?#]+)${q(post)}(?:#(?:block=([A-Za-z0-9_-]{1,64})|live))?$`).exec(text.trim());
  if (!m) return null;
  let fileId = m[1];
  try {
    fileId = decodeURIComponent(fileId);
  } catch {
    return null;
  }
  return ID.test(fileId) ? { fileId, blockId: m[2] || undefined, live: text.trim().endsWith("#live") || undefined } : null;
}

/** The link "Copy link" gives for a live file or a block: the host's `[host.live] link`. */
export function linkFor(l: BlockLink): string | null {
  const t = liveCfg.get().link;
  if (!t) return null;
  return t.replace("{fileId}", encodeURIComponent(l.fileId)) + (l.blockId ? `#block=${l.blockId}` : l.live ? "#live" : "");
}

/** Writes a block link to the clipboard: the URL as text and the marker as HTML. */
export async function copyBlockLink(l: BlockLink, fallbackText: string): Promise<void> {
  const url = linkFor(l) ?? fallbackText;
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": new Blob([url], { type: "text/plain" }), "text/html": new Blob([linkHtml(url, l)], { type: "text/html" }) }),
      ]);
      return;
    }
  } catch {
    /* fall back to text */
  }
  await navigator.clipboard?.writeText(url).catch(() => undefined);
}
