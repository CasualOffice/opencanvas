// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Show changes (VH-02b, frames 4a-4c): the server's diff drawn on the read-only preview.
// Text: ProseMirror decorations (green underline for added words, red strike for removed ones,
// a bar and a gutter sign per block). Databases, boards and the title: marks on their DOM,
// re-applied when their views re-render. Never colour alone: every mark also has a sign,
// a strike, an underline or a dashed/dotted outline, and the change list says it in words.
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { cellText, mapRuns, nodeText, type Change, type Diff, type Kind } from "./changes";

const key = new PluginKey<DecorationSet>("vhChanges");

export const changesPlugin = () =>
  new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(key) as DecorationSet | undefined;
        return next ?? set.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (s) => key.getState(s) },
  });

const WORD: Record<Kind, string> = { add: "Added", rem: "Removed", chg: "Changed", move: "Moved" };

/** A block of the newer side, by id first, else by its `/content/i/content/j` path. */
export function findBlock(doc: PMNode, ref: { blockId?: string; path?: string }): { pos: number; node: PMNode } | null {
  if (ref.blockId) {
    let hit: { pos: number; node: PMNode } | null = null;
    doc.descendants((n, pos) => {
      if (hit) return false;
      if (n.attrs.blockId === ref.blockId) {
        hit = { pos, node: n };
        return false;
      }
      return !n.isTextblock;
    });
    if (hit) return hit;
  }
  if (!ref.path) return null;
  const idx = ref.path.split("/").filter((s) => /^\d+$/.test(s)).map(Number);
  let node = doc;
  let start = 0; // where `node`'s content starts
  let pos = -1;
  for (const i of idx) {
    if (i >= node.childCount) return null;
    let p = start;
    for (let k = 0; k < i; k++) p += node.child(k).nodeSize;
    pos = p;
    node = node.child(i);
    start = p + 1;
  }
  return pos < 0 ? null : { pos, node };
}

function textPos(node: PMNode, pos: number, off: number): number {
  let acc = 0;
  let out = pos + node.nodeSize - 1;
  let found = false;
  node.forEach((child, childOff) => {
    if (found || !child.isText) return;
    const len = child.text?.length ?? 0;
    if (off <= acc + len) {
      out = pos + 1 + childOff + (off - acc);
      found = true;
    }
    acc += len;
  });
  return out;
}

function removedEl(text: string, label: string, keyAttr: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "vh-b vh-rem";
  el.dataset.vhKey = keyAttr;
  el.setAttribute("contenteditable", "false");
  const d = document.createElement("del");
  d.textContent = text || label;
  el.append(d);
  return el;
}

const ATOM_LABEL: Record<string, string> = { database: "Database", board: "Board", image: "Image", bookmark: "Link card", embed: "Embed", fileAttachment: "File", horizontalRule: "Divider", table: "Table" };

/** Draws (or with null, clears) the text and block changes on the preview editor. */
export function setTextChanges(editor: Editor, d: Diff | null, changes: Change[]) {
  if (editor.isDestroyed) return;
  const doc = editor.state.doc;
  const decos: Decoration[] = [];
  if (d) {
    const idxOf = new Map<unknown, number>();
    changes.forEach((c, i) => {
      if (c.target.t === "block") idxOf.set(c.target.blockId ?? c.target.path, i);
    });
    for (const b of d.blocks ?? []) {
      if (b.op === "removed") {
        let at = 0;
        if (b.after) {
          const a = findBlock(doc, b.after);
          if (a) at = a.pos + a.node.nodeSize;
        } else {
          const parent = b.path.replace(/\/content\/\d+$/, "");
          const p = parent ? findBlock(doc, { path: parent }) : null;
          if (p) at = p.pos + 1;
        }
        const label = ATOM_LABEL[b.type ?? ""] ?? "Block";
        const text = nodeText(b.node);
        decos.push(Decoration.widget(at, () => removedEl(text, label, b.blockId ?? b.path), { side: -1, key: "rm:" + (b.blockId ?? b.path), ignoreSelection: true }));
        continue;
      }
      const hit = findBlock(doc, b);
      if (!hit) continue;
      const kind: Kind = b.op === "added" ? "add" : b.op === "moved" ? "move" : "chg";
      const i = idxOf.get(b.blockId ?? b.path);
      decos.push(Decoration.node(hit.pos, hit.pos + hit.node.nodeSize, { class: `vh-b vh-${kind}`, "data-vh-i": String(i ?? ""), title: WORD[kind] + " in this version" }));
      if (b.op === "changed" && b.text && hit.node.isTextblock) {
        const m = mapRuns(hit.node.textContent, b.text as [string, string][]);
        if (!m) continue;
        for (const [f, t] of m.ins) if (t > f) decos.push(Decoration.inline(textPos(hit.node, hit.pos, f), textPos(hit.node, hit.pos, t), { nodeName: "ins", class: "vh-ins" }));
        m.del.forEach((x, k) => {
          const p = textPos(hit.node, hit.pos, x.at);
          decos.push(
            Decoration.widget(
              p,
              () => {
                const el = document.createElement("del");
                el.className = "vh-del";
                el.textContent = x.text;
                return el;
              },
              { side: -1, key: `del:${hit.pos}:${k}:${x.text}`, marks: [] },
            ),
          );
        });
      }
    }
  }
  editor.view.dispatch(editor.state.tr.setMeta(key, DecorationSet.create(doc, decos)).setMeta("addToHistory", false));
}

// ---------- databases, boards, title: DOM marks ----------

const MARK = "data-vh-mark";
const GHOST = "data-vh-ghost";
const CLASSES = ["vh-ra", "vh-cc", "vh-fa", "vh-fc", "vh-tchg", "vh-dbx", "vh-bdx"];
const SVG = "http://www.w3.org/2000/svg";

function mark(el: Element, cls: string, title?: string) {
  el.classList.add(cls);
  el.setAttribute(MARK, "");
  if (title && !el.getAttribute("title")) {
    el.setAttribute("title", title);
    el.setAttribute("data-vh-title", "");
  }
}

function clearDom(root: HTMLElement) {
  root.querySelectorAll(`[${GHOST}]`).forEach((e) => e.remove());
  root.querySelectorAll(`[${MARK}]`).forEach((e) => {
    e.classList.remove(...CLASSES);
    e.removeAttribute(MARK);
    if (e.hasAttribute("data-vh-title")) {
      e.removeAttribute("title");
      e.removeAttribute("data-vh-title");
    }
  });
}

function chips(counts: [string, number, string][], cls: string): HTMLElement {
  const box = document.createElement("div");
  box.className = cls;
  box.setAttribute(GHOST, "");
  for (const [tone, n, word] of counts) {
    if (!n) continue;
    const c = document.createElement("span");
    c.className = `vh-chip ${tone}`;
    c.textContent = `${n} ${word}`;
    box.append(c);
  }
  return box;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function applyDom(root: HTMLElement, d: Diff) {
  for (const m of d.meta ?? []) {
    if (m.field !== "title") continue;
    const t = root.querySelector(".dtitle");
    if (!t) continue;
    mark(t, "vh-tchg", "Title changed");
    const was = document.createElement("del");
    was.className = "vh-del vh-was-title";
    was.setAttribute(GHOST, "");
    was.textContent = String(m.old ?? "");
    t.parentElement?.insertBefore(was, t);
  }
  for (const db of d.databases ?? []) {
    if (db.op !== "changed") continue;
    const el = root.querySelector<HTMLElement>(`.ocdb[data-db="${CSS.escape(db.dbId)}"]`);
    if (!el) continue;
    mark(el, "vh-dbx");
    const cells = db.cells ?? [];
    const added = (db.rows ?? []).filter((r) => r.op === "added").length;
    const removed = (db.rows ?? []).filter((r) => r.op === "removed").length;
    el.parentElement?.insertBefore(
      chips(
        [
          ["green", added, added === 1 ? "row added" : "rows added"],
          ["red", removed, "removed"],
          ["amber", cells.length, cells.length === 1 ? "cell changed" : "cells changed"],
          ["amber", (db.fields ?? []).length, (db.fields ?? []).length === 1 ? "field changed" : "fields changed"],
        ],
        "vh-dbsum",
      ),
      el,
    );
    const ths = [...el.querySelectorAll<HTMLElement>("thead th[data-fid]")];
    for (const f of db.fields ?? []) {
      const th = ths.find((x) => x.dataset.fid === f.fieldId);
      if (th) mark(th, f.op === "added" ? "vh-fa" : "vh-fc", f.op === "added" ? "Field added" : `Field changed${f.old ? `: was ${String(f.old)}` : ""}`);
    }
    for (const r of db.rows ?? []) {
      if (r.op !== "added") continue;
      const tr = el.querySelector(`tr[data-row="${CSS.escape(r.rowId)}"]`);
      if (tr) mark(tr, "vh-ra", "Row added");
    }
    for (const c of cells) {
      const ci = ths.findIndex((x) => x.dataset.fid === c.fieldId);
      const td = ci >= 0 ? el.querySelector(`tr[data-row="${CSS.escape(c.rowId)}"] td[data-c="${ci}"]`) : null;
      if (!td) continue;
      mark(td, "vh-cc", `${c.field ?? "Cell"}: was ${cellText(c.old)}`);
      const was = document.createElement("del");
      was.className = "vh-was";
      was.setAttribute(GHOST, "");
      was.textContent = cellText(c.old);
      td.prepend(was);
    }
    const body = el.querySelector("table tbody");
    const cols = ths.length || 1;
    for (const r of db.rows ?? []) {
      if (r.op !== "removed" || !body) continue;
      const tr = document.createElement("tr");
      tr.className = "vh-rr";
      tr.setAttribute(GHOST, "");
      tr.dataset.vhKey = `${db.dbId}:${r.rowId}`;
      const td = document.createElement("td");
      td.colSpan = cols;
      const del = document.createElement("del");
      del.textContent = r.title || "Untitled";
      td.append(del);
      tr.append(td);
      body.append(tr);
    }
  }
  for (const bd of d.boards ?? []) {
    if (bd.op !== "changed") continue;
    const el = root.querySelector<HTMLElement>(`.stubhost[data-board="${CSS.escape(bd.boardId)}"]`);
    const first = el?.querySelector<SVGGElement>("g[data-s]");
    const layer = first?.parentElement;
    if (!el || !layer) continue;
    mark(el, "vh-bdx");
    const ov = svg("g", { class: "vh-ov", "pointer-events": "none" });
    ov.setAttribute(GHOST, "");
    const n = { add: 0, rem: 0, move: 0, chg: 0 };
    for (const s of bd.shapes ?? []) {
      if (s.op === "removed") {
        n.rem++;
        const x = s.shape?.x ?? 0, y = s.shape?.y ?? 0, w = s.shape?.w ?? 120, h = s.shape?.h ?? 60;
        const g = svg("g", { class: "vh-sr", "data-vh-key": `${bd.boardId}:${s.shapeId}` });
        g.append(svg("rect", { x, y, width: w, height: h, rx: 8 }));
        const t = svg("text", { x: x + w / 2, y: y + h / 2, "text-anchor": "middle", "dominant-baseline": "central" });
        t.textContent = s.shape?.text ?? "Removed";
        g.append(t);
        ov.append(g);
        continue;
      }
      const g = el.querySelector<SVGGElement>(`g[data-s="${CSS.escape(s.shapeId)}"]`);
      if (!g || typeof g.getBBox !== "function") continue;
      const b = g.getBBox();
      const pad = 5;
      const cls = s.op === "added" ? "vh-sa" : s.op === "moved" ? "vh-sm" : "vh-sc";
      n[s.op === "added" ? "add" : s.op === "moved" ? "move" : "chg"]++;
      ov.append(svg("rect", { class: cls, x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, rx: 10, "data-vh-shape": s.shapeId }));
      if (s.op === "moved" && s.from && s.to) {
        const dx = s.from[0] - s.to[0], dy = s.from[1] - s.to[1];
        ov.append(svg("rect", { class: "vh-sg", x: b.x + dx, y: b.y + dy, width: b.width, height: b.height, rx: 8 }));
        ov.append(svg("line", { class: "vh-sl", x1: b.x + dx + b.width / 2, y1: b.y + dy + b.height / 2, x2: b.x + b.width / 2, y2: b.y + b.height / 2 }));
      }
    }
    layer.append(ov);
    const leg = chips(
      [
        ["green", n.add, "added"],
        ["red", n.rem, "removed"],
        ["purple", n.move, "moved"],
        ["amber", n.chg, "changed"],
      ],
      "vh-bleg",
    );
    el.append(leg);
  }
}

/**
 * Marks the diff on the preview's databases, boards and title, and keeps the marks while their
 * views render (they load lazily and may re-render). Returns the cleanup.
 */
export function markDom(root: HTMLElement, d: Diff): () => void {
  let raf = 0;
  const obs = new MutationObserver(() => schedule());
  const run = () => {
    raf = 0;
    obs.disconnect();
    clearDom(root);
    applyDom(root, d);
    obs.observe(root, { childList: true, subtree: true });
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(run);
  };
  run();
  return () => {
    cancelAnimationFrame(raf);
    obs.disconnect();
    clearDom(root);
  };
}

/** The element a change is about, in the preview. */
export function targetOf(root: HTMLElement, c: Change, i: number): Element | null {
  const t = c.target;
  const esc = CSS.escape;
  switch (t.t) {
    case "meta":
      return root.querySelector(".dtitle");
    case "block":
      return root.querySelector(`[data-vh-i="${i}"]`);
    case "removed":
      return root.querySelector(`[data-vh-key="${esc(t.key)}"]`);
    case "db":
      return root.querySelector(`.ocdb[data-db="${esc(t.dbId)}"]`);
    case "row":
      return root.querySelector(`.ocdb[data-db="${esc(t.dbId)}"] tr[data-row="${esc(t.rowId)}"]`);
    case "field":
      return root.querySelector(`.ocdb[data-db="${esc(t.dbId)}"] th[data-fid="${esc(t.fieldId)}"]`);
    case "shape":
      return root.querySelector(`.stubhost[data-board="${esc(t.boardId)}"] [data-vh-shape="${esc(t.shapeId)}"]`) ?? root.querySelector(`.stubhost[data-board="${esc(t.boardId)}"]`);
  }
}

/** Changes in the order they appear on the page (the stepper and the phone list follow it). */
export function inPageOrder(root: HTMLElement, list: Change[]): { c: Change; i: number }[] {
  const withEl = list.map((c, i) => ({ c, i, el: targetOf(root, c, i) }));
  return withEl
    .map((x, k) => ({ ...x, k }))
    .sort((a, b) => {
      if (!a.el || !b.el) return a.el ? -1 : b.el ? 1 : a.k - b.k;
      if (a.el === b.el) return a.k - b.k;
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    })
    .map(({ c, i }) => ({ c, i }));
}
