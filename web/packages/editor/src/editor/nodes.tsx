// Custom Tiptap nodes per docs/15 §4. Node and attribute names are part of the
// file format: never rename them.
import { InputRule, Mark, Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import Image from "@tiptap/extension-image";
import CodeBlock from "@tiptap/extension-code-block";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import type * as Y from "yjs";
import { Ic } from "../icons";
import { useBridge, bridge } from "../lib/bridge";
import { EMBED_ALLOW, EMBED_SANDBOX, hostOf, providerLabel, resolveEmbed } from "../lib/embeds";
import { toast, useStore } from "../lib/store";
import { cancelUpload, retryUpload, uploadInto, uploadNow, uploadStore, type UploadState } from "../lib/uploads";
import { loadBoard, loadDatabase } from "./blockdata";

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
  const cycle = () => {
    if (!editor.isEditable) return;
    const i = CALLOUT_ICONS.indexOf(icon);
    const t = TONES.indexOf(tone as (typeof TONES)[number]);
    // Click cycles the tone; shift-click cycles the icon.
    updateAttributes({ tone: TONES[(t + 1) % TONES.length] });
    void i;
  };
  return (
    <NodeViewWrapper className="callout" data-tone={tone}>
      <button
        className={`cic tone-${tone}`}
        contentEditable={false}
        onClick={(e) => {
          if (!editor.isEditable) return;
          if (e.shiftKey || e.altKey) {
            const i = CALLOUT_ICONS.indexOf(icon);
            updateAttributes({ icon: CALLOUT_ICONS[(i + 1) % CALLOUT_ICONS.length] });
          } else cycle();
        }}
        title={editor.isEditable ? "Change colour (Shift-click: change icon)" : undefined}
        aria-label="Callout style"
        tabIndex={-1}
      >
        <Ic name={icon} />
      </button>
      <NodeViewContent className="callout-body" />
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
  parseHTML: () => [{ tag: 'div[data-type="columns"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns", class: "cols" }), 0],
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="column"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "column", class: "column" }), 0],
});

// ---------- bookmark (link card) ----------

function BookmarkView({ node }: ReactNodeViewProps) {
  const { url, title, description, site } = node.attrs as Record<string, string>;
  return (
    <NodeViewWrapper data-drag-handle="">
      <a
        className="bookmark"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        contentEditable={false}
        onClick={() => bridge.linkClick(url)}
      >
        <div className="bk">
          <div className="bt">{title || hostOf(url)}</div>
          {description ? <div className="bd">{description}</div> : null}
          <div className="bs">
            <Ic name="globe" size={12} />
            {site || hostOf(url)}
          </div>
        </div>
        <div className="bthumb">
          <Ic name="link-2" size={28} />
        </div>
      </a>
    </NodeViewWrapper>
  );
}

const atom = { group: "block", atom: true, selectable: true, draggable: true } as const;

export const Bookmark = Node.create({
  name: "bookmark",
  ...atom,
  addAttributes: () => ({ url: { default: "" }, title: { default: "" }, description: { default: "" }, site: { default: "" } }),
  parseHTML: () => [{ tag: 'div[data-type="bookmark"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "bookmark" })],
  addNodeView() {
    return ReactNodeViewRenderer(BookmarkView, ownEvents);
  },
});

// ---------- embed (sandboxed, allow-list) ----------

function EmbedView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const { provider, url, title } = node.attrs as Record<string, string>;
  const info = url ? resolveEmbed(url) : null;
  const [playing, setPlaying] = useState(false);
  const [draft, setDraft] = useState("");
  const label = info?.label ?? providerLabel(provider);
  if (!info) {
    return (
      <NodeViewWrapper>
        <div className="embed" contentEditable={false}>
          <div className="ehead">
            <Ic name="circle-play" size={14} />
            <span className="pv">{url ? "Can't embed this link" : "Embed"}</span>
            <span className="et">{title || (url ? hostOf(url) : "YouTube, Vimeo, Loom, Figma or Google Maps")}</span>
          </div>
          {editor.isEditable ? (
            <form
              className="pad"
              style={{ display: "flex", gap: 8, padding: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                const r = resolveEmbed(draft);
                if (!r) return toast("Only YouTube, Vimeo, Loom, Figma and Google Maps links can be embedded", { icon: "shield-check" });
                updateAttributes({ url: draft.trim(), provider: r.provider, title: title || hostOf(draft) });
              }}
            >
              <input className="pin" placeholder="Paste a video, design or map link" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Embed link" />
              <button className="btn sm" type="submit">
                Embed
              </button>
            </form>
          ) : null}
        </div>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      <div className="embed" contentEditable={false}>
        <div className="ehead">
          <Ic name="circle-play" size={14} />
          <span className="pv">{label}</span>
          <span className="et">{title || hostOf(url)}</span>
          <span className="tag">
            <Ic name="shield-check" size={12} />
            Sandboxed
          </span>
        </div>
        <div className={"ev" + (info.tall ? " tall" : "")}>
          {playing ? (
            <iframe src={info.src} title={title || label} sandbox={EMBED_SANDBOX} allow={EMBED_ALLOW} referrerPolicy="strict-origin-when-cross-origin" loading="lazy" allowFullScreen />
          ) : (
            <>
              <button className="play" onClick={() => setPlaying(true)} aria-label={`Load ${label}`}>
                <Ic name={info.provider === "youtube" || info.provider === "vimeo" || info.provider === "loom" ? "play" : "maximize-2"} size={26} />
              </button>
              <span className="ecap">{title || hostOf(url)}</span>
            </>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

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

export function fmtSize(n: number): string {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function fileTone(mime: string, name: string): string {
  if (/pdf/.test(mime) || /\.pdf$/i.test(name)) return "red";
  if (/sheet|csv|excel/.test(mime) || /\.(xlsx?|csv)$/i.test(name)) return "green";
  if (/presentation|powerpoint/.test(mime)) return "amber";
  if (/^image\//.test(mime)) return "purple";
  if (/zip|compressed/.test(mime)) return "gray";
  return "blue";
}

/** Local upload state for a node's transient `upload` attr (only the uploader has it). */
function useUpload(node: ReactNodeViewProps["node"]): [string | null, UploadState | undefined] {
  const id = (node.attrs.upload as string | null) ?? null;
  const all = useStore(uploadStore);
  return [id, id ? all[id] : undefined];
}

function UploadStatus({ id, up, label }: { id: string; up: UploadState; label: string }) {
  if (up.state === "error")
    return (
      <span className="upchip bad" role="status">
        <Ic name="triangle-alert" size={13} />
        <span className="ut">{label} didn't upload</span>
        <button onClick={() => retryUpload(id)}>
          <Ic name="rotate-ccw" size={13} />
          Retry
        </button>
        <button className="x" onClick={() => cancelUpload(id)} aria-label="Remove" title="Remove">
          <Ic name="x" size={13} />
        </button>
      </span>
    );
  return (
    <span className="upchip" role="status" aria-label={`Uploading, ${Math.round(up.progress * 100)}%`}>
      <Ic name="loader-circle" size={13} className="spin" />
      <span className="ut">Uploading {Math.round(up.progress * 100)}%</span>
    </span>
  );
}

function FileView({ node }: ReactNodeViewProps) {
  const { name, size, url, mime } = node.attrs as { name: string; size: number; url: string; mime: string };
  const b = useBridge();
  const [upId, up] = useUpload(node);
  const ext = (name.split(".").pop() ?? "").toUpperCase();
  return (
    <NodeViewWrapper>
      <div className={"attach" + (up ? " uploading" : "")} contentEditable={false}>
        <span className={`ftile tone-${fileTone(mime, name)}`}>
          <Ic name={/^image\//.test(mime) ? "image" : /sheet|csv/.test(mime) ? "file-spreadsheet" : "file-text"} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fname">{name || "Untitled file"}</div>
          <div className="fmeta">{[ext, fmtSize(Number(size))].filter(Boolean).join(" · ") || "File"}</div>
        </div>
        {up && upId ? (
          <UploadStatus id={upId} up={up} label="File" />
        ) : url && b.session?.perms?.download !== false ? (
          <a className="ib" href={url} download={name} target="_blank" rel="noopener noreferrer" title="Download" aria-label={`Download ${name}`}>
            <Ic name="download" />
          </a>
        ) : (
          <span className="ib" title={url ? "Downloads are turned off" : "Stored with the canvas"} aria-hidden>
            <Ic name="paperclip" />
          </span>
        )}
        {up?.state === "uploading" ? <span className="upbar" style={{ transform: `scaleX(${Math.max(0.04, up.progress)})` }} /> : null}
      </div>
    </NodeViewWrapper>
  );
}

/** Transient attr: the local upload id while bytes are in flight. Never part of exports. */
const uploadAttr = { upload: { default: null, rendered: false, keepOnSplit: false } };

export const FileAttachment = Node.create({
  name: "fileAttachment",
  ...atom,
  addAttributes: () => ({ name: { default: "" }, size: { default: 0 }, url: { default: "" }, mime: { default: "" }, ...uploadAttr }),
  parseHTML: () => [{ tag: 'div[data-type="fileAttachment"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "fileAttachment" })],
  addNodeView() {
    return ReactNodeViewRenderer(FileView, ownEvents);
  },
});

// ---------- image with caption and upload ----------

function ImageView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const { src, alt, caption } = node.attrs as { src: string; alt: string; caption: string };
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [upId, up] = useUpload(node);
  const b = useBridge();
  const fill = (f: File | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    uploadInto(editor, f, (a) => updateAttributes({ ...a, alt: alt || f.name.replace(/\.[^.]+$/, "") }));
  };
  const replace = async (f: File | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    setBusy(true);
    try {
      const r = await uploadNow(f);
      updateAttributes({ src: r.url });
    } catch {
      toast("The image didn't upload. Try again.", { icon: "triangle-alert" });
    } finally {
      setBusy(false);
    }
  };
  const shown = up?.preview ?? src;
  if (!shown) {
    return (
      <NodeViewWrapper>
        <button
          className={"upl" + (over ? " over" : "")}
          contentEditable={false}
          disabled={!editor.isEditable || !!up}
          onClick={() => b.pickFile("image/*", fill)}
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            fill(e.dataTransfer.files[0]);
          }}
        >
          <Ic name="image-plus" />
          {editor.isEditable ? "Upload an image or drop one here" : "Image"}
        </button>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      <figure className="figure" style={{ outline: selected ? "2px solid var(--accent-ring)" : undefined, borderRadius: 10 }}>
        <div className={"fwrap" + (up ? " uploading" : "")} contentEditable={false}>
          <img src={shown} alt={alt || caption || ""} draggable={false} />
          {up && upId ? (
            <div className="fup">
              <UploadStatus id={upId} up={up} label="Image" />
              {up.state === "uploading" ? <span className="upbar" style={{ transform: `scaleX(${Math.max(0.04, up.progress)})` }} /> : null}
            </div>
          ) : editor.isEditable ? (
            <div className="fbar">
              <button className="ib" title="Replace" aria-label="Replace image" disabled={busy} onClick={() => b.pickFile("image/*", replace)}>
                <Ic name={busy ? "loader-circle" : "image-plus"} size={14} className={busy ? "spin" : ""} />
              </button>
            </div>
          ) : null}
        </div>
        <CaptionInput value={caption} editable={editor.isEditable} onChange={(v) => updateAttributes({ caption: v })} />
      </figure>
    </NodeViewWrapper>
  );
}

function CaptionInput({ value, editable, onChange }: { value: string; editable: boolean; onChange(v: string): void }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  if (!editable && !value) return null;
  return (
    <input
      className="fcap"
      value={v}
      readOnly={!editable}
      placeholder={editable ? "Add a caption" : ""}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        if (v !== value) onChange(v);
      }}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      aria-label="Caption"
    />
  );
}

export const OcImage = Image.extend({
  draggable: true,
  addAttributes() {
    return { ...this.parent?.(), caption: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-caption") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-caption": a.caption }) }, ...uploadAttr };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, ownEvents);
  },
}).configure({ inline: false, allowBase64: true });

// ---------- code block with language header ----------

function CodeView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const lang = String(node.attrs.language ?? "");
  return (
    <NodeViewWrapper className="code">
      <div className="chead" contentEditable={false}>
        {editor.isEditable ? (
          <input value={lang} placeholder="text" onChange={(e) => updateAttributes({ language: e.target.value.replace(/[^\w+#-]/g, "").slice(0, 24) })} aria-label="Language" spellCheck={false} />
        ) : (
          <span>{lang || "text"}</span>
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
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

export const OcCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeView);
  },
});

// ---------- database & board (rendered by their packages, loaded on demand) ----------

const DatabaseBlock = lazy(() => loadDatabase().then((m) => ({ default: m.DatabaseBlock })));
const BoardBlock = lazy(() => loadBoard().then((m) => ({ default: m.BoardBlock })));

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

/** Placeholder with roughly the block's final size, so loading doesn't shift the page. */
function BlockSkeleton({ kind, rows = 3, view = "table" }: { kind: "db" | "board"; rows?: number; view?: string }) {
  if (kind === "board") return <div className="bskel board" aria-busy="true" aria-label="Loading whiteboard" />;
  const lines = Math.min(Math.max(rows, 1), 12);
  return (
    <div className="bskel db" aria-busy="true" aria-label="Loading database">
      <div className="bsh">
        <i style={{ width: 24, height: 24, borderRadius: 7 }} />
        <i style={{ width: 160, height: 14 }} />
      </div>
      <div className="bsb">
        <i style={{ width: 56 }} />
        <i style={{ width: 56 }} />
        <i style={{ width: 56 }} />
      </div>
      {view === "table" ? (
        <div className="bst">
          {Array.from({ length: lines + 1 }, (_, i) => (
            <div key={i} className={i ? "r" : "r h"}>
              <i style={{ width: "30%" }} />
              <i style={{ width: "16%" }} />
              <i style={{ width: "20%" }} />
              <i style={{ width: "12%" }} />
            </div>
          ))}
          <div className="f" />
        </div>
      ) : (
        <i className="bsg" style={{ height: view === "calendar" ? 520 : 300 }} />
      )}
    </div>
  );
}

function DatabaseView({ node }: ReactNodeViewProps) {
  const b = useBridge();
  const ref = useEdgeFade();
  const dbId = String(node.attrs.dbId);
  const m = b.doc.getMap("databases").get(dbId) as Y.Map<unknown> | undefined;
  const rows = (m?.get("order") as Y.Array<unknown> | undefined)?.length ?? 3;
  const view = String(m?.get("view") ?? "table");
  return (
    <NodeViewWrapper className="stubhost wideblock" data-db={node.attrs.dbId}>
      <div contentEditable={false} ref={ref}>
        <Suspense fallback={<BlockSkeleton kind="db" rows={rows} view={view} />}>
          <DatabaseBlock doc={b.doc} dbId={dbId} env={b.env} />
        </Suspense>
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
  return (
    <NodeViewWrapper className="stubhost wideblock" data-board={node.attrs.boardId}>
      <div contentEditable={false}>
        <Suspense fallback={<BlockSkeleton kind="board" />}>
          <BoardBlock doc={b.doc} boardId={String(node.attrs.boardId)} env={b.env} awareness={b.awareness} />
        </Suspense>
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
