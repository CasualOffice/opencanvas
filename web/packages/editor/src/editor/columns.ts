// Columns layout (LAY-01): 2–4 columns, widths snapped to quarters, optional column titles,
// the active column tinted, add / resize / remove affordances. Everything that is not the
// schema is a ProseMirror plugin with DOM widgets (no React, no extra chunk).
//
// File format (docs/15 §4, ADR-025): `columns.widths` = "25,75" (whole percents, one per
// column, absent = equal); `column.title` = optional label line (absent = none).
import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { toast } from "../lib/store";

/** Layout changes are their own undo steps (never merged with typing next to them). */
const ownStep = (state: EditorState) => yUndoPluginKey.getState(state)?.undoManager?.stopCapturing();

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;
const GAP = 28; // px, as in .cols
const MIN_PCT = 15;

/** Column widths in percent (sum 100). */
export function widthsOf(node: PMNode): number[] {
  const n = node.childCount;
  const raw = String(node.attrs.widths ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (raw.length !== n) return Array.from({ length: n }, () => 100 / n);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => (x / sum) * 100);
}

export const widthsAttr = (w: number[]): string | null => (w.every((x) => Math.abs(x - 100 / w.length) < 0.5) ? null : w.map((x) => Math.round(x)).join(","));

/** CSS for the columns grid. */
export function gridTemplate(widths: string | null | undefined): string | undefined {
  const w = String(widths ?? "")
    .split(",")
    .map(Number)
    .filter((x) => x > 0);
  return w.length >= MIN_COLUMNS ? w.map((x) => `minmax(0,${x}fr)`).join(" ") : undefined;
}

/**
 * Moves the boundary after column `i` to `pct` (of the row), snapped to quarters. Returns the
 * new widths, or null when a column would get narrower than {@link MIN_PCT}.
 */
export function moveBoundary(widths: number[], i: number, pct: number): number[] | null {
  const start = widths.slice(0, i).reduce((a, b) => a + b, 0);
  const end = start + widths[i] + widths[i + 1];
  const p = Math.round(pct / 25) * 25;
  if (p < start + MIN_PCT - 0.01 || p > end - MIN_PCT + 0.01) return null;
  const next = widths.slice();
  next[i] = p - start;
  next[i + 1] = end - p;
  return next;
}

/** The next quarter boundary left (-1) or right (+1) of the current one. */
export function stepBoundary(widths: number[], i: number, dir: -1 | 1): number[] | null {
  const at = widths.slice(0, i + 1).reduce((a, b) => a + b, 0);
  for (let q = dir > 0 ? Math.floor(at / 25 + 1e-6) + 1 : Math.ceil(at / 25 - 1e-6) - 1; q > 0 && q < 4; q += dir) {
    const r = moveBoundary(widths, i, q * 25);
    if (r) return r;
  }
  return null;
}

function setWidths(view: EditorView, pos: number, w: number[]) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "columns") return;
  ownStep(view.state);
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, widths: widthsAttr(w) }));
}

/** Inserts an empty column at `index` (equal widths again) and puts the caret in it. */
export function addColumn(view: EditorView, pos: number, index: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "columns" || node.childCount >= MAX_COLUMNS) return false;
  const s = view.state.schema;
  let at = pos + 1;
  for (let k = 0; k < index; k++) at += node.child(k).nodeSize;
  ownStep(view.state);
  const hasTitles = node.child(0).attrs.title != null;
  const col = s.nodes.column.create(hasTitles ? { title: "" } : null, s.nodes.paragraph.create());
  const tr = view.state.tr.insert(at, col);
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, widths: null });
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Removes column `index`; with two columns the other one's blocks replace the layout. */
export function removeColumn(view: EditorView, pos: number, index: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "columns") return false;
  let at = pos + 1;
  for (let k = 0; k < index; k++) at += node.child(k).nodeSize;
  const col = node.child(index);
  ownStep(view.state);
  const tr = view.state.tr;
  if (node.childCount <= MIN_COLUMNS) {
    const keep = node.child(index === 0 ? 1 : 0);
    tr.replaceWith(pos, pos + node.nodeSize, keep.content);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))));
  } else {
    tr.delete(at, at + col.nodeSize);
    const w = widthsOf(node);
    w.splice(index, 1);
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, widths: widthsAttr(w.map((x) => (x / w.reduce((a, b) => a + b, 0)) * 100)) });
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(pos + 1, Math.min(at, tr.doc.content.size - 1))), -1));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Adds (or removes) the optional title line of every column in the layout. */
export function setColumnTitles(editor: Editor, pos: number, on: boolean) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "columns") return;
  ownStep(editor.state);
  const tr = editor.state.tr;
  let at = pos + 1;
  node.forEach((c) => {
    tr.setNodeMarkup(at, undefined, { ...c.attrs, title: on ? (c.attrs.title ?? "") : null });
    at += c.nodeSize;
  });
  editor.view.dispatch(tr);
  if (on) window.setTimeout(() => editor.view.dom.querySelector<HTMLInputElement>(`.cols[data-pos="${pos}"] .coltitle input`)?.focus(), 30);
}

const isEmptyColumn = (c: PMNode) => c.childCount === 1 && c.firstChild!.type.name === "paragraph" && c.firstChild!.content.size === 0;

function activeColumn(state: EditorState): { pos: number; node: PMNode } | null {
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--) {
    if ($f.node(d).type.name === "column") return { pos: $f.before(d), node: $f.node(d) };
  }
  return null;
}

// ---------- DOM widgets ----------

const SVG = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// Lucide "plus" and "x" (ISC).
const PLUS = SVG('<path d="M5 12h14"/><path d="M12 5v14"/>');
const X = SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

/** `left` of a point at `pct` of the row, in a grid with n columns and GAP gaps. */
const leftAt = (cum: number, i: number, n: number) => `calc((100% - ${GAP * (n - 1)}px) * ${cum / 100} + ${GAP * i}px)`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function toolsWidget(view: EditorView, getPos: () => number | undefined, node: PMNode): HTMLElement {
  const n = node.childCount;
  const w = widthsOf(node);
  const root = el("div", "coltools", { contenteditable: "false" });
  const posNow = () => getPos() ?? -1;
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const start = cum;
    cum += w[i];
    // "Remove column" on an empty column.
    if (isEmptyColumn(node.child(i))) {
      const rm = el("button", "colrm", { type: "button", "aria-label": `Remove column ${i + 1}`, title: "Remove column", style: `left:${leftAt(start + w[i], i, n)}` });
      rm.innerHTML = X + "<span>Remove column</span>";
      rm.addEventListener("mousedown", (e) => e.preventDefault());
      rm.addEventListener("click", () => {
        const p = posNow();
        if (p >= 0 && removeColumn(view, p, i)) toast("Column removed", { icon: "columns-2", action: { label: "Undo", run: () => undoView(view) } });
      });
      root.appendChild(rm);
    }
    // "Add column" after this one (between, or at the end).
    if (n < MAX_COLUMNS) {
      const last = i === n - 1;
      const add = el("button", "coladd" + (last ? " end" : ""), {
        type: "button",
        "aria-label": last ? "Add a column at the end" : `Add a column after column ${i + 1}`,
        title: "Add column",
        style: `left:${last ? "100%" : leftAt(cum, i, n)}`,
      });
      add.innerHTML = PLUS;
      add.addEventListener("mousedown", (e) => e.preventDefault());
      add.addEventListener("click", () => {
        const p = posNow();
        if (p >= 0) addColumn(view, p, i + 1);
      });
      root.appendChild(add);
    }
    if (i === n - 1) break;
    // Resize handle on the boundary.
    const pct = Math.round(cum);
    const sep = el("div", "colresize", {
      role: "separator",
      tabindex: "0",
      "aria-orientation": "vertical",
      "aria-label": `Width of columns ${i + 1} and ${i + 2}`,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(pct),
      "aria-valuetext": `Column ${i + 1} ends at ${pct} percent`,
      title: "Drag to resize, or use the arrow keys",
      style: `left:${leftAt(cum, i, n)}`,
    });
    sep.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      const p = posNow();
      const cur = view.state.doc.nodeAt(p);
      if (!cur) return;
      const next = stepBoundary(widthsOf(cur), i, e.key === "ArrowLeft" ? -1 : 1);
      if (!next) return;
      setWidths(view, p, next);
      requestAnimationFrame(() => (view.dom.querySelector<HTMLElement>(`.cols[data-pos="${p}"] .colresize[aria-label="Width of columns ${i + 1} and ${i + 2}"]`) ?? null)?.focus());
    });
    sep.addEventListener("pointerdown", (e) => {
      const grid = sep.closest<HTMLElement>(".cols");
      if (!grid) return;
      e.preventDefault();
      sep.setPointerCapture(e.pointerId);
      const box = grid.getBoundingClientRect();
      let last: number[] | null = null;
      grid.classList.add("resizing");
      const move = (ev: PointerEvent) => {
        const p = posNow();
        const cur = view.state.doc.nodeAt(p);
        if (!cur) return;
        const next = moveBoundary(widthsOf(cur), i, ((ev.clientX - box.left) / box.width) * 100);
        if (next && next.join() !== (last ?? widthsOf(cur)).join()) {
          last = next;
          grid.style.gridTemplateColumns = next.map((x) => `minmax(0,${x}fr)`).join(" ");
        }
      };
      const up = () => {
        sep.removeEventListener("pointermove", move);
        sep.removeEventListener("pointerup", up);
        sep.removeEventListener("pointercancel", up);
        grid.classList.remove("resizing");
        if (last) setWidths(view, posNow(), last);
      };
      sep.addEventListener("pointermove", move);
      sep.addEventListener("pointerup", up);
      sep.addEventListener("pointercancel", up);
    });
    root.appendChild(sep);
  }
  return root;
}

function undoView(view: EditorView) {
  const ed = (view.dom as HTMLElement & { editor?: Editor }).editor;
  ed?.commands.undo();
}

function titleWidget(view: EditorView, getPos: () => number | undefined, title: string, editable: boolean, index: number): HTMLElement {
  const box = el("div", "coltitle", { contenteditable: "false" });
  if (!editable) {
    box.textContent = title;
    box.setAttribute("role", "heading");
    box.setAttribute("aria-level", "4");
    return box;
  }
  const input = el("input", "", { "aria-label": `Column ${index + 1} title`, placeholder: "Column title", maxlength: "120" });
  input.value = title;
  const save = () => {
    const pos = (getPos() ?? 0) - 1; // widget sits at the column's content start
    const col = view.state.doc.nodeAt(pos);
    if (!col || col.type.name !== "column" || col.attrs.title === input.value) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...col.attrs, title: input.value }));
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      save();
      const pos = getPos() ?? 0;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
      view.focus();
    } else if (e.key === "Escape") {
      input.blur();
      view.focus();
    }
  });
  box.appendChild(input);
  return box;
}

const key = new PluginKey<DecorationSet>("ocColumns");

export const ColumnTools = Extension.create({
  name: "columnTools",
  // Before the default Backspace chain (joinBackward does nothing across an isolating column).
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      // Backspace at the start of an empty column removes the column (Undo in the toast).
      Backspace: ({ editor }) => {
        const { state, view } = editor;
        const sel = state.selection;
        if (!sel.empty || sel.$from.parentOffset !== 0) return false;
        const col = activeColumn(state);
        if (!col || !isEmptyColumn(col.node)) return false;
        const $c = state.doc.resolve(col.pos);
        const layoutPos = $c.before($c.depth);
        const index = $c.index($c.depth);
        if (!removeColumn(view, layoutPos, index)) return false;
        toast("Column removed", { icon: "columns-2", action: { label: "Undo", run: () => editor.commands.undo() } });
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const build = (state: EditorState): DecorationSet => {
      const decos: Decoration[] = [];
      const editable = editor.isEditable;
      const active = activeColumn(state);
      state.doc.descendants((node, pos) => {
        if (node.type.name !== "columns") return node.isBlock && !node.isAtom;
        decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-pos": String(pos) }));
        if (editable) {
          const sig = [node.childCount, node.attrs.widths, ...Array.from({ length: node.childCount }, (_, i) => (isEmptyColumn(node.child(i)) ? 1 : 0))].join("|");
          decos.push(Decoration.widget(pos + 1, (view, getPos) => toolsWidget(view, () => (getPos() ?? 0) - 1, view.state.doc.nodeAt((getPos() ?? 0) - 1) ?? node), { key: `tools:${sig}`, side: -1, ignoreSelection: true, stopEvent: () => true }));
        }
        let at = pos + 1;
        node.forEach((c, _o, i) => {
          if (c.attrs.title != null) {
            const t = String(c.attrs.title);
            decos.push(Decoration.widget(at + 1, (view, getPos) => titleWidget(view, getPos, t, editable, i), { key: `title:${editable}:${i}:${t}`, side: -1, ignoreSelection: true, stopEvent: () => true }));
          }
          if (active && active.pos === at) decos.push(Decoration.node(at, at + c.nodeSize, { class: "col-active" }));
          at += c.nodeSize;
        });
        return false;
      });
      return DecorationSet.create(state.doc, decos);
    };
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_c, state) => build(state),
          apply: (tr: Transaction, old, _o, state) => (tr.docChanged || tr.selectionSet || tr.getMeta(key) ? build(state) : old.map(tr.mapping, tr.doc)),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
