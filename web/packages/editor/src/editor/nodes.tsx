// Custom Tiptap nodes per docs/15 §4. Node and attribute names are part of the
// file format: never rename them.
import { InputRule, Mark, Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import Image from "@tiptap/extension-image";
import CodeBlock from "@tiptap/extension-code-block";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { DatabaseBlock } from "@opencanvas/database";
import { BoardBlock } from "@opencanvas/board";
import { Ic } from "../icons";
import { useBridge, bridge } from "../lib/bridge";
import { EMBED_ALLOW, EMBED_SANDBOX, hostOf, providerLabel, resolveEmbed } from "../lib/embeds";
import { toast } from "../lib/store";

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

function FileView({ node }: ReactNodeViewProps) {
  const { name, size, url, mime } = node.attrs as { name: string; size: number; url: string; mime: string };
  const b = useBridge();
  const ext = (name.split(".").pop() ?? "").toUpperCase();
  return (
    <NodeViewWrapper>
      <div className="attach" contentEditable={false}>
        <span className={`ftile tone-${fileTone(mime, name)}`}>
          <Ic name={/^image\//.test(mime) ? "image" : /sheet|csv/.test(mime) ? "file-spreadsheet" : "file-text"} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="fname">{name || "Untitled file"}</div>
          <div className="fmeta">{[ext, fmtSize(Number(size))].filter(Boolean).join(" · ") || "File"}</div>
        </div>
        {url && b.session?.perms?.download !== false ? (
          <a className="ib" href={url} download={name} target="_blank" rel="noopener noreferrer" title="Download" aria-label={`Download ${name}`}>
            <Ic name="download" />
          </a>
        ) : (
          <span className="ib" title={url ? "Downloads are turned off" : "Stored with the canvas"} aria-hidden>
            <Ic name="paperclip" />
          </span>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const FileAttachment = Node.create({
  name: "fileAttachment",
  ...atom,
  addAttributes: () => ({ name: { default: "" }, size: { default: 0 }, url: { default: "" }, mime: { default: "" } }),
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
  const b = useBridge();
  const take = async (f: File | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    setBusy(true);
    try {
      const up = await b.upload(f);
      updateAttributes({ src: up.url, alt: alt || f.name });
    } catch {
      toast("The image didn't upload. Try again.", { icon: "triangle-alert" });
    } finally {
      setBusy(false);
    }
  };
  if (!src) {
    return (
      <NodeViewWrapper>
        <button
          className={"upl" + (over ? " over" : "")}
          contentEditable={false}
          disabled={!editor.isEditable || busy}
          onClick={() => b.pickFile("image/*", take)}
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            setOver(false);
            void take(e.dataTransfer.files[0]);
          }}
        >
          <Ic name={busy ? "loader-circle" : "image-plus"} className={busy ? "spin" : ""} />
          {busy ? "Uploading…" : editor.isEditable ? "Upload an image or drop one here" : "Image"}
        </button>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      <figure className="figure" style={{ outline: selected ? "2px solid var(--accent-ring)" : undefined, borderRadius: 10 }}>
        <div className="fwrap" contentEditable={false}>
          <img src={src} alt={alt || caption || ""} draggable={false} />
          {editor.isEditable ? (
            <div className="fbar">
              <button className="ib" title="Replace" aria-label="Replace image" onClick={() => b.pickFile("image/*", take)}>
                <Ic name="image-plus" size={14} />
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
    return { ...this.parent?.(), caption: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-caption") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-caption": a.caption }) } };
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

// ---------- database & board (rendered by their packages) ----------

function DatabaseView({ node }: ReactNodeViewProps) {
  const b = useBridge();
  return (
    <NodeViewWrapper className="stubhost" data-db={node.attrs.dbId}>
      <div contentEditable={false}>
        <DatabaseBlock doc={b.doc} dbId={String(node.attrs.dbId)} env={b.env} />
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
    <NodeViewWrapper className="stubhost" data-board={node.attrs.boardId}>
      <div contentEditable={false}>
        <BoardBlock doc={b.doc} boardId={String(node.attrs.boardId)} env={b.env} awareness={b.awareness} />
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
