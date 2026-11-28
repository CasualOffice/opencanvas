// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Custom Tiptap nodes per docs/15 §4. Node and attribute names are part of the
// file format: never rename them.
import { useIsAppRoot } from "../lib/appmode";
import { InputRule, Mark, Node, mergeAttributes, type Editor } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import Image from "@tiptap/extension-image";
import CodeBlock from "@tiptap/extension-code-block";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import type * as Y from "yjs";
import { Ic } from "../icons";
import { useBridge, bridge, type Bridge } from "../lib/bridge";
import { createStore, toast, useStore } from "../lib/store";
import { loadBoard, loadDatabase, loadSheet } from "./blockdata";
import { BlockPlaceholder, useRetryingLazy } from "./placeholder";
import { CODE_LANGS, canonicalLang, langLabel } from "./codelangs";
import { Popover } from "../components/overlay";
import { keyLabel } from "../lib/keys";
import { clampWidth } from "./imagelayout";
import { gridTemplate } from "./columns";
import { FILE_EVENT } from "./files/kind";
export type { ImageAlign } from "./atomviews";

type AtomViews = typeof import("./atomviews");
let atomViews: AtomViews | null = null;
let atomLoad: Promise<AtomViews> | null = null;
/** The file, image, link card and embed views are their own chunk (WEB-08 budget). Fetched as
 *  soon as this module runs, so it is in before a document's first sync. */
export const loadAtomViews = () => (atomLoad ??= import("./atomviews").then((m) => (atomViews = m)));
void loadAtomViews().catch(() => (atomLoad = null));

/** A node view that renders the loaded atom view, or an empty wrapper for the moment it takes. */
function atomView(name: "FileView" | "ImageView" | "BookmarkView" | "EmbedView") {
  function AtomView(props: ReactNodeViewProps) {
    const [, loaded] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
      if (!atomViews) void loadAtomViews().then(loaded, loaded);
    }, []);
    const View = atomViews?.[name];
    return View ? <View {...props} /> : <NodeViewWrapper><div className="atom-loading" contentEditable={false} aria-busy="true" /></NodeViewWrapper>;
  }
  return AtomView;
}
const BookmarkView = atomView("BookmarkView");
const EmbedView = atomView("EmbedView");
const FileView = atomView("FileView");
const ImageView = atomView("ImageView");

const TONES = ["blue", "green", "amber", "red", "purple", "pink", "gray"] as const;
const CALLOUT_ICONS = ["lightbulb", "info", "target", "triangle-alert", "sparkles", "clock", "calendar", "flag", "star", "map-pin"];

/** Interactive atom node views own their events; ProseMirror must not eat them. */
const ownEvents = {
  stopEvent: ({ event }: { event: Event }) => !(event.type.startsWith("drag") || event.type === "drop"),
  ignoreMutation: () => true,
};

// ---------- callout ----------

function CalloutView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const tone = String(node.attrs.tone ?? "blue");
  const icon = String(node.attrs.icon ?? "lightbulb");
  const [pick, setPick] = useState<HTMLElement | null>(null);
  return (
    <NodeViewWrapper className="callout" data-tone={tone}>
      <button
        className={`cic tone-${tone}`}
        contentEditable={false}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => editor.isEditable && setPick(pick ? null : e.currentTarget)}
        title={editor.isEditable ? "Change colour and icon" : undefined}
        aria-label={editor.isEditable ? "Callout colour and icon" : "Callout"}
        aria-haspopup={editor.isEditable ? "dialog" : undefined}
        aria-expanded={editor.isEditable ? !!pick : undefined}
        disabled={!editor.isEditable}
      >
        <Ic name={icon} />
      </button>
      <NodeViewContent className="callout-body" />
      {pick ? (
        <Popover anchor={pick} onClose={() => setPick(null)} title="Callout" kind="dialog" minWidth={260}>
          <div className="mh">Colour</div>
          <div className="tones" role="group" aria-label="Colour">
            {TONES.map((t) => (
              <button key={t} className={`tone-${t}` + (tone === t ? " on" : "")} aria-label={t[0].toUpperCase() + t.slice(1)} aria-pressed={tone === t} onClick={() => updateAttributes({ tone: t })} />
            ))}
          </div>
          <div className="mh">Icon</div>
          <div className="icongrid" role="group" aria-label="Icon">
            {CALLOUT_ICONS.map((n) => (
              <button
                key={n}
                className={icon === n ? "on" : ""}
                aria-label={n.replace(/-/g, " ")}
                aria-pressed={icon === n}
                onClick={() => {
                  updateAttributes({ icon: n });
                  setPick(null);
                }}
              >
                <Ic name={n} size={18} />
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "paragraph+",
  defining: true,
  addAttributes() {
    return {
      tone: { default: "blue", parseHTML: (el) => el.getAttribute("data-tone") ?? "blue", renderHTML: (a) => ({ "data-tone": a.tone }) },
      icon: { default: "lightbulb", parseHTML: (el) => el.getAttribute("data-icon") ?? "lightbulb", renderHTML: (a) => ({ "data-icon": a.icon }) },
    };
  },
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout" }), 0],
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

// ---------- toggle ----------

function ToggleView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [localOpen, setLocalOpen] = useState<boolean>(!!node.attrs.open);
  useEffect(() => setLocalOpen(!!node.attrs.open), [node.attrs.open]);
  const open = localOpen;
  return (
    <NodeViewWrapper className={"toggle" + (open ? " open" : "")}>
      <button
        className="tchev"
        contentEditable={false}
        aria-expanded={open}
        aria-label={open ? "Collapse" : "Expand"}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        title={`${open ? "Collapse" : "Expand"} (${keyLabel("Mod-Enter")})`}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setLocalOpen(!open);
          // Viewers can expand locally; only editors persist the state.
          if (editor.isEditable) updateAttributes({ open: !open });
        }}
      >
        <Ic name="chevron-right" />
      </button>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "toggleSummary toggleContent",
  defining: true,
  addAttributes() {
    return { open: { default: true, parseHTML: (el) => el.getAttribute("data-open") !== "false", renderHTML: (a) => ({ "data-open": String(!!a.open) }) } };
  },
  parseHTML: () => [{ tag: 'div[data-type="toggle"]' }, { tag: "details" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggle" }), 0],
  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },
  addKeyboardShortcuts() {
    return {
      // ⌘/Ctrl+Enter anywhere inside a toggle opens or closes it: the chevron is not in the tab order.
      "Mod-Enter": ({ editor }) => {
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const n = $from.node(d);
          if (n.type.name !== "toggle") continue;
          const at = $from.before(d);
          const open = !n.attrs.open;
          return editor
            .chain()
            .command(({ tr }) => {
              tr.setNodeMarkup(at, undefined, { ...n.attrs, open });
              // Closing with the caret in the hidden body: move it to the summary.
              if (!open && $from.parent.type.name !== "toggleSummary") tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)));
              return true;
            })
            .run();
        }
        return false;
      },
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "toggleSummary") return false;
        const toggle = $from.node($from.depth - 1);
        const togglePos = $from.before($from.depth - 1);
        return editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(togglePos, undefined, { ...toggle.attrs, open: true });
            // summary: togglePos+1 … ; content starts after summary
            const contentStart = togglePos + 1 + toggle.child(0).nodeSize;
            tr.setSelection(TextSelection.near(tr.doc.resolve(contentStart + 2)));
            return true;
          })
          .run();
      },
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^>>\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== "paragraph") return null;
          const s = state.schema;
          const start = $from.before();
          const node = s.nodes.toggle.create({ open: true }, [s.nodes.toggleSummary.create(), s.nodes.toggleContent.create(null, s.nodes.paragraph.create())]);
          const tr = state.tr;
          tr.replaceWith(start, $from.after(), node);
          tr.setSelection(TextSelection.create(tr.doc, start + 2));
        },
      }),
    ];
  },
});

export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: 'div[data-type="toggleSummary"]' }, { tag: "summary" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggleSummary", class: "toggle-summary" }), 0],
});

export const ToggleContent = Node.create({
  name: "toggleContent",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: 'div[data-type="toggleContent"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggleContent", class: "toggle-content" }), 0],
});

// ---------- columns ----------

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  defining: true,
  isolating: true,
  addAttributes: () => ({
    // LAY-01 (ADR-025): whole percents per column, "25,75"; absent = equal widths.
    widths: {
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute("data-widths"),
      renderHTML: (a: Record<string, unknown>) => {
        const t = gridTemplate(a.widths as string | null);
        return t ? { "data-widths": String(a.widths), style: `grid-template-columns:${t}` } : {};
      },
    },
  }),
  parseHTML: () => [{ tag: 'div[data-type="columns"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns", class: "cols" }), 0],
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  addAttributes: () => ({
    // Optional label line above the column's blocks (absent = none, "" = shown, empty).
    title: {
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute("data-title"),
      renderHTML: (a: Record<string, unknown>) => (a.title != null ? { "data-title": String(a.title) } : {}),
    },
  }),
  parseHTML: () => [{ tag: 'div[data-type="column"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "column", class: "column" }), 0],
});

// ---------- bookmark (link card) ----------


const atom = { group: "block", atom: true, selectable: true, draggable: true } as const;

export const Bookmark = Node.create({
  name: "bookmark",
  ...atom,
  addAttributes: () => ({ url: { default: "" }, title: { default: "" }, description: { default: "" }, site: { default: "" }, image: { default: "" } }),
  parseHTML: () => [{ tag: 'div[data-type="bookmark"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "bookmark" })],
  addNodeView() {
    return ReactNodeViewRenderer(BookmarkView, ownEvents);
  },
});

// ---------- embed (sandboxed, allow-list) ----------


export const Embed = Node.create({
  name: "embed",
  ...atom,
  addAttributes: () => ({ provider: { default: "" }, url: { default: "" }, title: { default: "" } }),
  parseHTML: () => [{ tag: 'div[data-type="embed"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "embed" })],
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView, ownEvents);
  },
});

// ---------- file attachment ----------

export { fmtSize } from "./files/kind";







/** Transient attr: the local upload id while bytes are in flight. Never part of exports. */
const uploadAttr = { upload: { default: null, rendered: false, keepOnSplit: false } };

export const FileAttachment = Node.create({
  name: "fileAttachment",
  ...atom,
  addAttributes: () => ({
    name: { default: "" },
    size: { default: 0 },
    url: { default: "" },
    mime: { default: "" },
    // FILE-01 (ADR-025): "card" | "preview"; absent = preview for PDFs, card otherwise.
    display: {
      default: null,
      parseHTML: (el: HTMLElement) => (["card", "preview"].includes(el.getAttribute("data-display") ?? "") ? el.getAttribute("data-display") : null),
      renderHTML: (a: Record<string, unknown>) => (a.display ? { "data-display": String(a.display) } : {}),
    },
    // Inline preview height in CSS px; absent = 70 % of the viewport, at most 900.
    height: {
      default: null,
      parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-height")) || null,
      renderHTML: (a: Record<string, unknown>) => (a.height ? { "data-height": String(a.height) } : {}),
    },
    ...uploadAttr,
  }),
  parseHTML: () => [{ tag: 'div[data-type="fileAttachment"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "fileAttachment" })],
  addNodeView() {
    return ReactNodeViewRenderer(FileView, ownEvents);
  },
  addKeyboardShortcuts() {
    // Enter or Space on a selected attachment opens the preview.
    const preview = ({ editor }: { editor: Editor }) => {
      const sel = editor.state.selection as unknown as { node?: { type: { name: string } }; from: number };
      if (sel.node?.type.name !== "fileAttachment") return false;
      const dom = editor.view.nodeDOM(sel.from) as HTMLElement | null;
      const el = dom?.querySelector?.(".filev");
      if (!el) return false;
      el.dispatchEvent(new CustomEvent(FILE_EVENT, { detail: "preview" }));
      return true;
    };
    return { Enter: preview, Space: preview };
  },
});

// ---------- image with caption and upload ----------





export const OcImage = Image.extend({
  draggable: true,
  addAttributes() {
    return {
      ...this.parent?.(),
      caption: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-caption") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-caption": a.caption }) },
      // Optional layout (ADR-023): width in % of the text column, alignment. Default = full width, centred.
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => clampWidth(el.getAttribute("data-width")),
        renderHTML: (a: Record<string, unknown>) => (a.width ? { "data-width": String(a.width) } : {}),
      },
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => (["left", "right"].includes(el.getAttribute("data-align") ?? "") ? el.getAttribute("data-align") : null),
        renderHTML: (a: Record<string, unknown>) => (a.align ? { "data-align": String(a.align) } : {}),
      },
      ...uploadAttr,
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, ownEvents);
  },
}).configure({ inline: false, allowBase64: true });

// ---------- code block: language picker, copy, lazy highlighting ----------

type HighlightModule = typeof import("./highlight");
const hlStore = createStore<HighlightModule | null>(null);
let hlLoad: Promise<HighlightModule> | null = null;
const loadHighlight = () => (hlLoad ??= import("./highlight").then((m) => (hlStore.set(m), m)));
const hlInstalled = new WeakSet<Editor>();

function hasCodeBlock(editor: Editor) {
  let found = false;
  editor.state.doc.descendants((n) => {
    if (found) return false;
    if (n.type.name === "codeBlock") found = true;
    return !found;
  });
  return found;
}

/** Load the grammars after first paint, and only once the document has a code block. */
function ensureHighlight(editor: Editor) {
  if (hlInstalled.has(editor) || !hasCodeBlock(editor)) return;
  hlInstalled.add(editor);
  requestAnimationFrame(() =>
    window.setTimeout(() => {
      loadHighlight()
        .then((m) => m.installHighlight(editor))
        .catch(() => hlInstalled.delete(editor));
    }, 0),
  );
}

function CodeView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const stored = String(node.attrs.language ?? "");
  const lang = canonicalLang(stored);
  const hl = useStore(hlStore);
  const text = node.textContent;
  const detected = useMemo(() => (!lang && hl ? hl.detect(text) : null), [lang, hl, text]);
  const known = CODE_LANGS.some(([id]) => id === lang);
  const label = lang ? langLabel(lang) : detected ? `Auto · ${langLabel(detected)}` : "Auto-detect";
  return (
    <NodeViewWrapper className="code" data-language={lang || undefined}>
      <div className="chead" contentEditable={false}>
        {editor.isEditable ? (
          <label className="clang">
            <span>{label}</span>
            <Ic name="chevron-down" size={12} />
            <select value={known ? lang : stored} onChange={(e) => updateAttributes({ language: e.target.value || null })} aria-label="Code language">
              {known ? null : <option value={stored}>{stored}</option>}
              {CODE_LANGS.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="clang">{label}</span>
        )}
        <button
          className="ib"
          title="Copy code"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(node.textContent).catch(() => undefined);
            toast("Code copied", { icon: "copy" });
          }}
        >
          <Ic name="copy" size={14} />
        </button>
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<"code"> as="code" className="hljs" />
      </pre>
    </NodeViewWrapper>
  );
}

export const OcCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeView);
  },
  onCreate() {
    ensureHighlight(this.editor);
  },
  onUpdate() {
    ensureHighlight(this.editor);
  },
});

// ---------- database & board (rendered by their packages, loaded on demand) ----------

const loadDbBlock = () => loadDatabase().then((m) => ({ default: m.DatabaseBlock }));
const loadBoardBlock = () => loadBoard().then((m) => ({ default: m.BoardBlock }));

/**
 * Database and board blocks break out of the 760px text column to a wider
 * measure (CSS `.wideblock`). Tables scroll sideways inside; this marks each
 * scroller with which edges hide more content so CSS can fade them.
 */
function useEdgeFade() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        host.querySelectorAll<HTMLElement>(".ocdb-gw, .ocdb-kan, .ocdb-tabs").forEach((el) => {
          const max = el.scrollWidth - el.clientWidth;
          const l = String(el.scrollLeft > 2);
          const r = String(max - el.scrollLeft > 2);
          if (el.dataset.fadeL !== l) el.dataset.fadeL = l;
          if (el.dataset.fadeR !== r) el.dataset.fadeR = r;
        });
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    const mo = new MutationObserver(measure);
    mo.observe(host, { childList: true, subtree: true });
    host.addEventListener("scroll", measure, { capture: true, passive: true });
    measure();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      host.removeEventListener("scroll", measure, { capture: true });
    };
  }, []);
  return ref;
}

/**
 * Database and board blocks are draggable atoms, so a press-and-move anywhere inside them
 * used to start a native drag of the whole block, which cancelled the block's own pointer
 * drags (moving shapes, resizing columns, kanban cards). They only worked in full screen,
 * where the block is portalled out of the draggable node. A drag that starts on the block
 * node itself is refused when the press began inside the block's content. Reordering still
 * works from the gutter handle, and draggable elements inside the block keep their own drags.
 */
function useContentOwnsDrag<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const inner = ref.current;
    // The draggable element is Tiptap's node container, above NodeViewWrapper.
    const node = inner?.closest<HTMLElement>('[draggable="true"]');
    if (!inner || !node) return;
    // Cancelling dragstart is too late: Chrome has already sent pointercancel to the block's
    // own gesture. Instead the node stops being draggable for the length of a press that
    // starts inside the content, so the browser never begins a block drag.
    const down = (e: PointerEvent) => {
      if (e.target instanceof globalThis.Node && inner.contains(e.target)) node.draggable = false;
    };
    const up = () => {
      node.draggable = true;
    };
    inner.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      inner.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      node.draggable = true;
    };
  }, []);
  return ref;
}

/** PSYNC-03: within one screen of the viewport (the part loads before it is seen). */
function useNearView(ref: RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), { rootMargin: "100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

/** PSYNC-03 (ADR-076): the document a database or board view edits. In a split room the block
 *  is a part: loaded when it comes within a screen of the viewport, released when it leaves
 *  (the client keeps it two more minutes). `null` doc: still loading (show the placeholder). */
function usePartDoc(b: Bridge, id: string, ref: RefObject<HTMLElement | null>) {
  const parts = b.parts ?? null;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => parts?.onChange(bump), [parts]);
  const near = useNearView(ref);
  const isPart = !!parts?.isPart(id);
  useEffect(() => {
    if (!parts || !isPart || !near) return;
    parts.acquire(id);
    bump();
    return () => parts.release(id);
  }, [parts, isPart, near, id]);
  const doc = isPart ? parts!.doc(id) : b.doc;
  const ready = !isPart || parts!.isSynced(id);
  const env = useMemo(() => {
    const um = isPart && doc ? parts!.undoFor(doc) : null;
    return um ? { ...b.env, undoManager: um } : b.env;
  }, [b.env, parts, isPart, doc]);
  return { doc: ready ? doc : null, env, header: isPart ? parts!.headers.get(id) : undefined };
}

function DatabaseView({ node }: ReactNodeViewProps) {
  const b = useBridge();
  const fadeRef = useEdgeFade();
  const dragRef = useContentOwnsDrag<HTMLDivElement>();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const ref = (el: HTMLDivElement | null) => {
    dragRef.current = el;
    fadeRef.current = el;
    boxRef.current = el;
  };
  const dbId = String(node.attrs.dbId);
  const part = usePartDoc(b, dbId, boxRef);
  const m = (part.doc ?? b.doc).getMap("databases").get(dbId) as Y.Map<unknown> | undefined;
  const rows = (m?.get("order") as Y.Array<unknown> | undefined)?.length ?? part.header?.count ?? 3;
  const view = String(m?.get("view") ?? "table");
  const fields = (m?.get("fields") as Y.Array<unknown> | undefined)?.length;
  const name = (m?.get("name") as string | undefined) ?? part.header?.name;
  const { Comp: DatabaseBlock, failed, wrap } = useRetryingLazy(loadDbBlock);
  const appDb = useIsAppRoot(dbId);
  const ph = <BlockPlaceholder info={{ kind: "db", name, count: rows, fields, view }} failed={failed} />;
  return (
    <NodeViewWrapper className={"stubhost wideblock" + (appDb ? " app-root" : "")} data-db={node.attrs.dbId}>
      <div contentEditable={false} ref={ref}>
        {part.doc ? wrap(<Suspense fallback={ph}><DatabaseBlock doc={part.doc} dbId={dbId} env={appDb ? { ...part.env, app: true } : part.env} /></Suspense>, ph) : ph}
      </div>
    </NodeViewWrapper>
  );
}

export const Database = Node.create({
  name: "database",
  ...atom,
  addAttributes: () => ({ dbId: { default: "" } }),
  parseHTML: () => [{ tag: 'div[data-type="database"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "database" })],
  addNodeView() {
    return ReactNodeViewRenderer(DatabaseView, ownEvents);
  },
});

function BoardView({ node }: ReactNodeViewProps) {
  const b = useBridge();
  const ref = useContentOwnsDrag<HTMLDivElement>();
  const boardId = String(node.attrs.boardId);
  const part = usePartDoc(b, boardId, ref);
  const { Comp: BoardBlock, failed, wrap } = useRetryingLazy(loadBoardBlock);
  const appBoard = useIsAppRoot(boardId);
  const ph = <BlockPlaceholder info={{ kind: "board", name: part.header?.name, count: part.header?.count }} failed={failed} />;
  return (
    <NodeViewWrapper className="stubhost wideblock" data-board={node.attrs.boardId}>
      <div contentEditable={false} ref={ref}>
        {part.doc ? wrap(<Suspense fallback={ph}><BoardBlock key={appBoard ? "app" : "doc"} doc={part.doc} boardId={boardId} env={appBoard ? { ...part.env, app: true } : part.env} awareness={b.awareness} /></Suspense>, ph) : ph}
      </div>
    </NodeViewWrapper>
  );
}

export const Board = Node.create({
  name: "board",
  ...atom,
  addAttributes: () => ({ boardId: { default: "" } }),
  parseHTML: () => [{ tag: 'div[data-type="board"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "board" })],
  addNodeView() {
    return ReactNodeViewRenderer(BoardView, ownEvents);
  },
});

// ---------- spreadsheet (SHEET-04; @opencanvas/sheet, loaded on demand) ----------

const loadSheetBlock = () => loadSheet().then((m) => ({ default: m.SheetBlock }));

const loadSheetLink = () => import("./chart/SheetLink").then((m) => ({ default: m.SheetLink }));
const SheetLinkLazy = lazy(loadSheetLink);

/** The person present with the lowest client id (repairs a live view's rows on open). */
const isLeader = (b: Bridge) => {
  const ids = [...(b.awareness?.getStates().keys() ?? [])];
  return !ids.length || Math.min(...ids) >= b.doc.clientID;
};

function SpreadsheetView({ node }: ReactNodeViewProps) {
  const b = useBridge();
  const ref = useContentOwnsDrag<HTMLDivElement>();
  const sheetId = String(node.attrs.sheetId);
  // v0.4.1: in a split room the spreadsheet is a part (`sheets/<id>`), loaded near the screen.
  const part = usePartDoc(b, sheetId, ref);
  // SHEET-06 (8a): a live view of a database keeps in step with it (the link is in the sheet).
  const linkMap = (part.doc?.getMap("sheets").get(sheetId) as Y.Map<unknown> | undefined)?.get("link") as Y.Map<unknown> | undefined;
  const linkDb = String(linkMap?.get("db") ?? "");
  const dbPart = usePartDoc(b, linkDb, ref);
  const { Comp: SheetBlock, failed, wrap } = useRetryingLazy(loadSheetBlock);
  const appSheet = useIsAppRoot(sheetId);
  const ph = <BlockPlaceholder info={{ kind: "sheet" }} failed={failed} />;
  return (
    <NodeViewWrapper className="stubhost wideblock" data-sheet={sheetId}>
      <div contentEditable={false} ref={ref}>
        {linkDb && part.doc ? <Suspense fallback={null}><SheetLinkLazy doc={part.doc} block={sheetId} dbDoc={dbPart.doc} dbId={linkDb} env={part.env} leader={() => isLeader(b)} /></Suspense> : null}
        {part.doc ? wrap(<Suspense fallback={ph}><SheetBlock key={appSheet ? "app" : "doc"} doc={part.doc} blockId={sheetId} env={appSheet ? { ...part.env, app: true } : part.env} awareness={b.awareness ?? undefined} chart={ChartLazy} /></Suspense>, ph) : ph}
      </div>
    </NodeViewWrapper>
  );
}

// ---------- linked chart (SHEET-06, frame 4h; plain SVG, loaded on demand) ----------

const loadChartBlock = () => import("./chart/ChartBlock").then((m) => ({ default: m.ChartBlock }));
/** 4h: the same view, floating over a spreadsheet (handed to the sheet; loads on first use). */
const ChartLazy = lazy(loadChartBlock) as unknown as import("@opencanvas/sheet").SheetChartView;

function ChartView({ node, updateAttributes }: ReactNodeViewProps) {
  const b = useBridge();
  const ref = useContentOwnsDrag<HTMLDivElement>();
  const a = node.attrs as import("./chart/data").ChartAttrs;
  const part = usePartDoc(b, a.src === "db" ? a.dbId : "", ref);
  // v0.4.1: a chart of a spreadsheet reads the sheet's part (null while it loads).
  const sheetPart = usePartDoc(b, a.src === "sheet" ? a.sheetId : "", ref);
  const parts = b.parts?.split ? b.parts.list() : undefined;
  const { Comp: ChartBlock, failed, wrap } = useRetryingLazy(loadChartBlock);
  const ph = <BlockPlaceholder info={{ kind: "chart", name: a.title || "Chart" }} failed={failed} />;
  return (
    <NodeViewWrapper className="stubhost" data-chart="">
      <div contentEditable={false} ref={ref}>
        {wrap(<Suspense fallback={ph}><ChartBlock attrs={a} set={updateAttributes} doc={b.doc} dbDoc={part.doc} sheetDoc={sheetPart.doc} parts={parts} env={part.env} /></Suspense>, ph)}
      </div>
    </NodeViewWrapper>
  );
}

const CHART_ATTRS = ["kind", "title", "src", "sheetId", "sheet", "r0", "r1", "c0", "c1", "dbId", "groupBy", "agg", "field", "xLabel", "yLabel"] as const;
const CHART_DEFAULT: Record<string, string> = { kind: "bar", agg: "count" };

export const Chart = Node.create({
  name: "chart",
  ...atom,
  addAttributes: () => ({
    ...Object.fromEntries(CHART_ATTRS.map((k) => [k, { default: CHART_DEFAULT[k] ?? "" }])),
    legend: { default: true },
  }),
  parseHTML: () => [{ tag: 'div[data-type="chart"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "chart" })],
  addNodeView() {
    return ReactNodeViewRenderer(ChartView, ownEvents);
  },
});

export const Spreadsheet = Node.create({
  name: "spreadsheet",
  ...atom,
  addAttributes: () => ({ sheetId: { default: "" } }),
  parseHTML: () => [{ tag: 'div[data-type="spreadsheet"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "spreadsheet" })],
  addNodeView() {
    return ReactNodeViewRenderer(SpreadsheetView, ownEvents);
  },
});

// ---------- comment mark ----------

export const CommentMark = Mark.create({
  name: "commentMark",
  inclusive: false,
  excludes: "",
  addAttributes: () => ({
    threadId: { default: null, parseHTML: (el) => el.getAttribute("data-thread"), renderHTML: (a) => ({ "data-thread": a.threadId }) },
  }),
  parseHTML: () => [{ tag: "span[data-thread]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "cmt" }), 0],
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("commentClick"),
        props: {
          handleClick: (_view, _pos, event) => {
            const el = (event.target as HTMLElement | null)?.closest?.(".cmt[data-thread]");
            if (!el) return false;
            bridge.openThread(el.getAttribute("data-thread") ?? "");
            return false;
          },
        },
      }),
    ];
  },
});
