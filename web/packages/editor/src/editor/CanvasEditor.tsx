import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { offset } from "@floating-ui/dom";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { OcUser, Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { bridge } from "../lib/bridge";
import { createThread, newThreadId } from "../lib/comments";
import { hostOf, resolveEmbed } from "../lib/embeds";
import { createStore, toast, useStore } from "../lib/store";
import { Popover, useShell, type Anchor } from "../components/overlay";
import { Board, Bookmark, Callout, CommentMark, Column, Columns, Database, Embed, FileAttachment, OcCodeBlock, OcImage, Toggle, ToggleContent, ToggleSummary } from "./nodes";
import { SlashCommand, TURN, bookmarkNode, currentKind, turnInto, type SlashItem } from "./slash";
import { dismissSuggest, suggestRender, suggestStore } from "./suggest";

export interface EditorProps {
  doc: Y.Doc;
  awareness: Awareness;
  role: Role;
  me: OcUser;
  users: OcUser[];
  searchUsers(q: string): Promise<OcUser[]>;
  onReady(e: Editor | null): void;
  onComment(threadId: string): void;
}

// ---------- paste a URL → offer link / card / embed ----------

interface PasteOffer {
  url: string;
  from: number;
  to: number;
  rect: DOMRect;
}
const pasteStore = createStore<PasteOffer | null>(null);

const PasteUrl = Extension.create({
  name: "pasteUrl",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("pasteUrl"),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
            if (!/^https?:\/\/\S+$/.test(text) || !view.state.selection.empty) return false;
            const { from } = view.state.selection;
            if (view.state.selection.$from.parent.type.spec.code) return false;
            editor.chain().insertContent({ type: "text", text, marks: [{ type: "link", attrs: { href: text } }] }).run();
            const to = from + text.length;
            const c = view.coordsAtPos(to);
            pasteStore.set({ url: text, from, to, rect: new DOMRect(c.left, c.top, 1, c.bottom - c.top) });
            return true;
          },
        },
      }),
    ];
  },
});

function initialsOf(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

function colorFor(id: string): string {
  const u = bridge.env?.users?.find((x) => x.id === id) ?? (bridge.env?.me?.id === id ? bridge.env.me : undefined);
  if (u) return u.color;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ["#2a5ad7", "#7a45f0", "#e5602a", "#0e9a78", "#d63f78", "#b7791f", "#0b7fa6"][h % 7];
}

export function CanvasEditor(p: EditorProps) {
  const { compact, root } = useShell();
  const searchRef = useRef(p.searchUsers);
  searchRef.current = p.searchUsers;
  const editable = p.role === "edit";

  const editor = useEditor(
    {
      editable,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: { attributes: { class: "oc-prose", spellcheck: "true", "aria-label": "Canvas" } },
      extensions: [
        StarterKit.configure({
          undoRedo: false,
          codeBlock: false,
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
          dropcursor: { width: 3, class: "ProseMirror-dropcursor" },
        }),
        OcCodeBlock,
        Collaboration.configure({ document: p.doc, field: "content" }),
        CollaborationCaret.configure({
          provider: { awareness: p.awareness },
          user: { id: p.me.id, name: p.me.name, color: p.me.color, role: p.role },
          render: (u: Record<string, string>) => {
            const c = document.createElement("span");
            c.className = "collaboration-carets__caret";
            c.style.borderColor = u.color;
            if (u.id) c.dataset.uid = u.id;
            const l = document.createElement("div");
            l.className = "collaboration-carets__label";
            l.style.background = u.color;
            l.textContent = u.name;
            c.append(l);
            return c;
          },
          selectionRender: (u: Record<string, string>) => ({
            nodeName: "span",
            class: "collaboration-carets__selection",
            style: `background-color: color-mix(in srgb, ${u.color} 20%, transparent)`,
            "data-user": u.name,
          }),
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit.configure({ table: { resizable: true, cellMinWidth: 80 } }),
        Highlight,
        Placeholder.configure({
          includeChildren: true,
          showOnlyCurrent: true,
          placeholder: ({ node }) =>
            node.type.name === "heading" ? "Heading" : node.type.name === "toggleSummary" ? "Toggle" : "Type '/' for blocks",
        }),
        Mention.configure({
          HTMLAttributes: { class: "mention" },
          renderHTML: ({ node }) => {
            const id = String(node.attrs.id ?? "");
            const label = String(node.attrs.label ?? id);
            return [
              "span",
              { class: "mention", "data-type": "mention", "data-id": id, "data-label": label },
              ["span", { class: "av", style: `background:${colorFor(id)}` }, initialsOf(label)],
              label,
            ];
          },
          renderText: ({ node }) => "@" + (node.attrs.label ?? node.attrs.id),
          suggestion: {
            char: "@",
            items: async ({ query }) => (await searchRef.current(query)).slice(0, 8).map((u) => ({ id: u.id, label: u.name, color: u.color })),
            render: suggestRender("mention"),
          },
        }),
        Callout,
        Toggle,
        ToggleSummary,
        ToggleContent,
        Columns,
        Column,
        Bookmark,
        Embed,
        FileAttachment,
        OcImage,
        Database,
        Board,
        CommentMark,
        SlashCommand,
        PasteUrl,
      ],
    },
    [p.doc],
  );

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    p.onReady(editor);
    return () => p.onReady(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // typing indicator for the avatar stack (docs/06 §3)
  useEffect(() => {
    let t: number | undefined;
    const on = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      if (!transaction.docChanged || isChangeOrigin(transaction)) return;
      if (!p.awareness.getLocalState()?.typing) p.awareness.setLocalStateField("typing", true);
      window.clearTimeout(t);
      t = window.setTimeout(() => p.awareness.setLocalStateField("typing", false), 1500);
    };
    editor.on("transaction", on);
    return () => {
      editor.off("transaction", on);
      window.clearTimeout(t);
    };
  }, [editor, p.awareness]);

  return (
    <>
      <EditorContent editor={editor} />
      {editable && !compact ? <Gutter editor={editor} onComment={p.onComment} /> : null}
      {!compact && p.role !== "view" ? <SelectionToolbar editor={editor} role={p.role} onComment={p.onComment} /> : null}
      <SuggestMenu editor={editor} />
      <PasteMenu editor={editor} />
      <PeerBars editor={editor} awareness={p.awareness} />
      {compact && p.role !== "view" && root ? <MobileBar editor={editor} role={p.role} onComment={p.onComment} /> : null}
    </>
  );
}

// ---------- comments from the editor ----------

export function startComment(editor: Editor, role: Role, onComment: (id: string) => void, range?: { from: number; to: number }) {
  const { from, to } = range ?? editor.state.selection;
  const quote = editor.state.doc.textBetween(from, to, " ").trim();
  if (!quote) return toast("Select some text to comment on", { icon: "message-square-plus" });
  const id = newThreadId();
  createThread(bridge.doc, id, quote);
  if (role === "edit") editor.chain().setTextSelection({ from, to }).setMark("commentMark", { threadId: id }).run();
  onComment(id);
}

// ---------- block gutter: + and grip, with the block menu ----------

function Gutter({ editor, onComment }: { editor: Editor; onComment(id: string): void }) {
  const cur = useRef<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });
  const [menu, setMenu] = useState<{ anchor: Anchor; node: PMNode; pos: number } | null>(null);
  const pos = useMemo(() => ({ placement: "left-start" as const, strategy: "absolute" as const, middleware: [offset({ mainAxis: 6, crossAxis: 3 })] }), []);

  const close = () => {
    setMenu(null);
    editor.commands.setMeta("lockDragHandle", false);
  };

  return (
    <>
      <DragHandle editor={editor} computePositionConfig={pos} onNodeChange={({ node, pos }) => (cur.current = { node, pos })}>
        <div className="gut">
          <button
            title="Insert below"
            aria-label="Insert block below"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const { node, pos } = cur.current;
              if (!node) return;
              if (node.type.name === "paragraph" && node.content.size === 0) {
                editor.chain().focus().setTextSelection(pos + 1).insertContent("/").run();
                return;
              }
              const at = pos + node.nodeSize;
              editor.chain().focus().insertContentAt(at, { type: "paragraph", content: [{ type: "text", text: "/" }] }).setTextSelection(at + 2).run();
            }}
          >
            <Ic name="plus" size={15} />
          </button>
          <button
            className="grip"
            title="Drag to move, click for options"
            aria-label="Block options"
            onClick={(e) => {
              const { node, pos } = cur.current;
              if (!node) return;
              editor.commands.setMeta("lockDragHandle", true);
              setMenu({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), node, pos });
            }}
          >
            <Ic name="grip-vertical" size={15} />
          </button>
        </div>
      </DragHandle>
      {menu ? <BlockMenu editor={editor} anchor={menu.anchor} node={menu.node} pos={menu.pos} onClose={close} onComment={onComment} /> : null}
    </>
  );
}

const TEXTY = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "callout"]);

function cloneEmbeddedData(json: Record<string, unknown>): Record<string, unknown> {
  // Duplicated database/board blocks get their own copy of the data.
  const walk = (n: Record<string, unknown>) => {
    const attrs = n.attrs as Record<string, unknown> | undefined;
    if (n.type === "database" && attrs?.dbId) {
      const root = bridge.doc.getMap("databases");
      const src = root.get(String(attrs.dbId)) as Y.Map<unknown> | undefined;
      if (src) {
        const id = "db_" + Math.random().toString(36).slice(2, 10);
        root.set(id, src.clone());
        attrs.dbId = id;
      }
    }
    if (n.type === "board" && attrs?.boardId) {
      const root = bridge.doc.getMap("boards");
      const src = root.get(String(attrs.boardId)) as Y.Map<unknown> | undefined;
      if (src) {
        const id = "brd_" + Math.random().toString(36).slice(2, 10);
        root.set(id, src.clone());
        attrs.boardId = id;
      }
    }
    (n.content as Record<string, unknown>[] | undefined)?.forEach(walk);
  };
  walk(json);
  return json;
}

export function BlockMenu({ editor, anchor, node, pos, onClose, onComment }: { editor: Editor; anchor: Anchor; node: PMNode; pos: number; onClose(): void; onComment(id: string): void }) {
  const texty = TEXTY.has(node.type.name);
  const selectInside = () => editor.chain().focus().setTextSelection(Math.min(pos + 1, editor.state.doc.content.size)).run();
  const kind = (() => {
    if (!texty) return "";
    selectInside();
    return currentKind(editor);
  })();
  const run = (fn: () => void) => {
    onClose();
    fn();
  };
  const doc = editor.state.doc;
  const idx = (() => {
    let i = -1;
    doc.forEach((_n, off, j) => {
      if (off === pos) i = j;
    });
    return i;
  })();
  const move = (dir: -1 | 1) => {
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= doc.childCount) return;
    const other = doc.child(j);
    editor
      .chain()
      .command(({ tr }) => {
        if (dir === -1) {
          const target = pos - other.nodeSize;
          tr.delete(pos, pos + node.nodeSize);
          tr.insert(target, node);
        } else {
          tr.delete(pos, pos + node.nodeSize);
          tr.insert(pos + other.nodeSize, node);
        }
        return true;
      })
      .run();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} title="Block" minWidth={230}>
      {texty ? (
        <>
          <div className="mh">Turn into</div>
          {TURN.map(([id, icon, label]) => (
            <button key={id} className="mi" onClick={() => run(() => (selectInside(), turnInto(editor, id)))}>
              <Ic name={icon} />
              {label}
              {kind === id ? (
                <span className="chk">
                  <Ic name="check" size={14} />
                </span>
              ) : null}
            </button>
          ))}
          <div className="msep" />
        </>
      ) : null}
      <button
        className="mi"
        onClick={() =>
          run(() => {
            const json = cloneEmbeddedData(node.toJSON());
            editor.chain().focus().insertContentAt(pos + node.nodeSize, json).run();
          })
        }
      >
        <Ic name="copy" />
        Duplicate
        <span className="mk">⌘D</span>
      </button>
      <button
        className="mi"
        onClick={() =>
          run(() => {
            const link = `${bridge.session?.file?.name ?? "Canvas"} · block ${idx + 1}`;
            void navigator.clipboard?.writeText(link).catch(() => undefined);
            toast("Link to block copied", { icon: "link" });
          })
        }
      >
        <Ic name="link" />
        Copy link to block
      </button>
      <button
        className="mi"
        onClick={() =>
          run(() => {
            const from = pos + 1;
            const to = pos + node.nodeSize - 1;
            if (node.isTextblock || texty) startComment(editor, "edit", onComment, { from, to });
            else {
              const id = newThreadId();
              createThread(bridge.doc, id, node.type.name === "database" ? "Database" : node.type.name === "board" ? "Whiteboard" : node.textContent || "Block");
              onComment(id);
            }
          })
        }
      >
        <Ic name="message-square-plus" />
        Comment
      </button>
      <button className="mi" disabled={idx <= 0} onClick={() => run(() => move(-1))}>
        <Ic name="arrow-up" />
        Move up
      </button>
      <button className="mi" disabled={idx < 0 || idx >= doc.childCount - 1} onClick={() => run(() => move(1))}>
        <Ic name="arrow-down" />
        Move down
      </button>
      <div className="msep" />
      <button
        className="mi danger"
        onClick={() =>
          run(() => {
            editor.chain().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
            toast("Block deleted", { icon: "trash-2", action: { label: "Undo", run: () => editor.commands.undo() } });
          })
        }
      >
        <Ic name="trash-2" />
        Delete
      </button>
    </Popover>
  );
}

// ---------- floating selection toolbar ----------

function SelectionToolbar({ editor, role, onComment }: { editor: Editor; role: Role; onComment(id: string): void }) {
  const [linkMode, setLinkMode] = useState(false);
  const [href, setHref] = useState("");
  const [turn, setTurn] = useState<{ anchor: Anchor; pos: number; node: PMNode } | null>(null);
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      mark: e.isActive("highlight"),
      link: e.isActive("link"),
    }),
  });
  const edit = role === "edit";
  const btn = (key: keyof typeof st, icon: string, label: string, run: () => void) => (
    <button className={"ib" + (st[key] ? " on" : "")} title={label} aria-label={label} aria-pressed={st[key]} onClick={run}>
      <Ic name={icon} />
    </button>
  );
  const applyLink = () => {
    const v = href.trim();
    if (!v) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: /^(https?:|mailto:)/.test(v) ? v : "https://" + v }).run();
    setLinkMode(false);
  };
  return (
    <>
      <BubbleMenu
        editor={editor}
        className="ftb"
        updateDelay={0}
        options={{ placement: "top", offset: 8, flip: true }}
        shouldShow={({ editor: e, state, from, to }) => {
          if (from === to || state.selection instanceof NodeSelection) return false;
          if (!e.isFocused && !linkMode) return false;
          const $f = state.selection.$from;
          if ($f.parent.type.spec.code) return false;
          return true;
        }}
      >
        {linkMode ? (
          <>
            <input
              autoFocus
              placeholder="Paste a link and press Enter"
              aria-label="Link URL"
              value={href}
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLink();
                }
                if (e.key === "Escape") {
                  setLinkMode(false);
                  editor.commands.focus();
                }
              }}
            />
            <button className="ib" aria-label="Apply link" onClick={applyLink}>
              <Ic name="check" />
            </button>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 1 }} onMouseDown={(e) => e.preventDefault()}>
            {edit ? (
              <>
                <button
                  className="tsel"
                  onClick={(e) => {
                    const $f = editor.state.selection.$from;
                    const p = $f.before(1);
                    const node = editor.state.doc.nodeAt(p);
                    if (node) setTurn({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), pos: p, node });
                  }}
                >
                  Turn into
                  <Ic name="chevron-down" size={12} />
                </button>
                <span className="vs" />
                {btn("bold", "bold", "Bold (⌘B)", () => editor.chain().focus().toggleBold().run())}
                {btn("italic", "italic", "Italic (⌘I)", () => editor.chain().focus().toggleItalic().run())}
                {btn("underline", "underline", "Underline (⌘U)", () => editor.chain().focus().toggleUnderline().run())}
                {btn("strike", "strikethrough", "Strikethrough", () => editor.chain().focus().toggleStrike().run())}
                {btn("code", "code-xml", "Inline code", () => editor.chain().focus().toggleCode().run())}
                {btn("mark", "highlighter", "Highlight", () => editor.chain().focus().toggleHighlight().run())}
                {btn("link", "link", "Link (⌘K)", () => {
                  setHref(editor.getAttributes("link").href ?? "");
                  setLinkMode(true);
                })}
                <span className="vs" />
              </>
            ) : null}
            <button className="ib" title="Comment" aria-label="Comment" onClick={() => startComment(editor, role, onComment)}>
              <Ic name="message-square-plus" />
            </button>
          </div>
        )}
      </BubbleMenu>
      {turn ? <BlockMenu editor={editor} anchor={turn.anchor} node={turn.node} pos={turn.pos} onClose={() => setTurn(null)} onComment={onComment} /> : null}
    </>
  );
}

// ---------- slash / mention suggestion menu ----------

function SuggestMenu({ editor }: { editor: Editor }) {
  const s = useStore(suggestStore);
  const { compact } = useShell();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" });
  }, [s?.sel]);
  if (!s || !s.rect) return null;
  const close = () => dismissSuggest();
  const hold = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault();

  if (s.kind === "mention") {
    const items = s.items as { id: string; label: string; color: string }[];
    return (
      <Popover anchor={s.rect} onClose={close} title="Mention" minWidth={240}>
        <div ref={listRef} onMouseDown={hold}>
          <div className="mh">People</div>
          {items.length ? (
            items.map((u, i) => (
              <button key={u.id} className={"mi" + (i === s.sel ? " on" : "")} onClick={() => s.pick(u)}>
                <span className="av sm" style={{ background: u.color }}>
                  {initialsOf(u.label)}
                </span>
                {u.label}
              </button>
            ))
          ) : (
            <div className="mh" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
              No one matches “{s.query}”
            </div>
          )}
        </div>
      </Popover>
    );
  }

  const items = s.items as SlashItem[];
  if (compact && !s.query) {
    return (
      <Popover anchor={s.rect} onClose={close} title="Insert">
        <div className="sgrid" onMouseDown={hold}>
          {items.map((x, i) => (
            <button key={x.id} className={i === s.sel ? "on" : ""} onClick={() => s.pick(x)}>
              <Ic name={x.icon} size={20} />
              {x.title}
            </button>
          ))}
        </div>
      </Popover>
    );
  }
  let group = "";
  void editor;
  return (
    <Popover anchor={s.rect} onClose={close} title="Insert" minWidth={300}>
      <div ref={listRef} onMouseDown={hold}>
        {items.length ? (
          items.map((x, i) => {
            const head = x.group !== group ? ((group = x.group), <div className="mh">{x.group}</div>) : null;
            return (
              <div key={x.id}>
                {head}
                <button className={"mi" + (i === s.sel ? " on" : "")} onClick={() => s.pick(x)} onMouseEnter={() => suggestStore.set({ ...s, sel: i })}>
                  <span className="tile">
                    <Ic name={x.icon} />
                  </span>
                  <span className="ml">
                    <b>{x.title}</b>
                    <span>{x.desc}</span>
                  </span>
                  {x.md ? <span className="mk">{x.md}</span> : null}
                </button>
              </div>
            );
          })
        ) : (
          <div className="mh" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
            No matching blocks
          </div>
        )}
      </div>
    </Popover>
  );
}

function PasteMenu({ editor }: { editor: Editor }) {
  const o = useStore(pasteStore);
  if (!o) return null;
  const close = () => pasteStore.set(null);
  const embed = resolveEmbed(o.url);
  const replace = (node: object) => {
    close();
    const $p = editor.state.doc.resolve(o.from);
    const blockEnd = $p.after(1);
    const blockEmpty = editor.state.doc.textBetween($p.before(1), blockEnd).trim() === o.url;
    let c = editor.chain().focus().deleteRange({ from: o.from, to: o.to });
    if (blockEmpty) c = c.insertContent(node);
    else c = c.insertContentAt(blockEnd - (o.to - o.from), node);
    c.run();
  };
  return (
    <Popover anchor={o.rect} onClose={close} title="Paste link" minWidth={200}>
      <div onMouseDown={(e) => e.preventDefault()}>
        <div className="mh">Paste as</div>
        <button className="mi" onClick={close}>
          <Ic name="link" />
          Link
        </button>
        <button className="mi" onClick={() => replace(bookmarkNode(o.url))}>
          <Ic name="panel-top" />
          Link preview
        </button>
        <button className="mi" disabled={!embed} title={embed ? undefined : "Only YouTube, Vimeo, Loom, Figma and Maps can be embedded"} onClick={() => embed && replace({ type: "embed", attrs: { provider: embed.provider, url: o.url, title: hostOf(o.url) } })}>
          <Ic name="circle-play" />
          Embed
        </button>
      </div>
    </Popover>
  );
}

// ---------- block-level presence bars (docs/06 §3) ----------

function PeerBars({ editor, awareness }: { editor: Editor; awareness: Awareness }) {
  const [bars, setBars] = useState<{ key: string; top: number; height: number; color: string }[]>([]);
  useEffect(() => {
    let raf = 0;
    const calc = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dom = editor.view.dom as HTMLElement;
        const host = dom.offsetParent as HTMLElement | null;
        if (!host) return;
        const hr = host.getBoundingClientRect();
        const out: typeof bars = [];
        const seen = new Set<Element>();
        dom.querySelectorAll<HTMLElement>(".collaboration-carets__caret").forEach((c) => {
          let blk: HTMLElement | null = c;
          while (blk && blk.parentElement !== dom) blk = blk.parentElement;
          if (!blk || seen.has(blk)) return;
          seen.add(blk);
          const r = blk.getBoundingClientRect();
          out.push({ key: (c.dataset.uid ?? "") + out.length, top: r.top - hr.top + 4, height: Math.max(12, r.height - 8), color: c.style.borderColor });
        });
        setBars(out);
      });
    };
    awareness.on("change", calc);
    editor.on("transaction", calc);
    const ro = new ResizeObserver(calc);
    ro.observe(editor.view.dom);
    calc();
    return () => {
      cancelAnimationFrame(raf);
      awareness.off("change", calc);
      editor.off("transaction", calc);
      ro.disconnect();
    };
  }, [editor, awareness]);
  return (
    <>
      {bars.map((b) => (
        <span key={b.key} className="peerbar" style={{ top: b.top, height: b.height, background: b.color }} />
      ))}
    </>
  );
}

// ---------- mobile editing toolbar (above the keyboard) ----------

function MobileBar({ editor, role, onComment }: { editor: Editor; role: Role; onComment(id: string): void }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ focused: e.isFocused, sel: !e.state.selection.empty && !(e.state.selection instanceof NodeSelection) }),
  });
  const [bottom, setBottom] = useState(8);
  const [turn, setTurn] = useState<{ pos: number; node: PMNode } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const f = () => setBottom(Math.max(8, window.innerHeight - (vv.height + vv.offsetTop) + 8));
    vv.addEventListener("resize", f);
    vv.addEventListener("scroll", f);
    f();
    return () => {
      vv.removeEventListener("resize", f);
      vv.removeEventListener("scroll", f);
    };
  }, []);
  const [keep, setKeep] = useState(false);
  useEffect(() => {
    if (st.focused) setKeep(true);
    else {
      const t = window.setTimeout(() => setKeep(false), 150);
      return () => window.clearTimeout(t);
    }
  }, [st.focused]);
  const edit = role === "edit";
  if ((!keep && !turn) || (!edit && !st.sel && !turn)) return null;
  const b = (icon: string, label: string, run: () => void, on = false) => (
    <button className={"ib" + (on ? " on" : "")} aria-label={label} title={label} onClick={run}>
      <Ic name={icon} size={18} />
    </button>
  );
  const blockAt = () => {
    const p = editor.state.selection.$from.before(1);
    const node = editor.state.doc.nodeAt(p);
    return node ? { pos: p, node } : null;
  };
  return (
    <>
      <div className="mbar" role="toolbar" aria-label="Editing tools" style={{ bottom }} onMouseDown={(e) => e.preventDefault()}>
        {st.sel ? (
          <>
            {edit ? (
              <>
                {b("bold", "Bold", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"))}
                {b("italic", "Italic", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"))}
                {b("underline", "Underline", () => editor.chain().focus().toggleUnderline().run(), editor.isActive("underline"))}
                {b("strikethrough", "Strikethrough", () => editor.chain().focus().toggleStrike().run(), editor.isActive("strike"))}
                {b("highlighter", "Highlight", () => editor.chain().focus().toggleHighlight().run(), editor.isActive("highlight"))}
                {b("link", "Link", () => {
                  const v = window.prompt("Link", editor.getAttributes("link").href ?? "https://");
                  if (v !== null) editor.chain().focus().extendMarkRange("link").setLink({ href: v }).run();
                })}
                <span className="vs" />
              </>
            ) : null}
            {b("message-square-plus", "Comment", () => startComment(editor, role, onComment))}
          </>
        ) : edit ? (
          <>
            {b("plus", "Insert block", () => editor.chain().focus().insertContent("/").run())}
            {b("type", "Turn into", () => setTurn(blockAt()))}
            {b("list-todo", "Checklist", () => editor.chain().focus().toggleTaskList().run(), editor.isActive("taskList"))}
            {b("list", "Bulleted list", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"))}
            {b("image", "Image", () => editor.chain().focus().insertContent([{ type: "image", attrs: { src: "" } }, { type: "paragraph" }]).run())}
            {b("at-sign", "Mention someone", () => editor.chain().focus().insertContent("@").run())}
            <span className="vs" />
            {b("keyboard", "Done editing", () => editor.commands.blur())}
          </>
        ) : null}
      </div>
      {turn ? <BlockMenu editor={editor} anchor={new DOMRect(0, 0, 0, 0)} node={turn.node} pos={turn.pos} onClose={() => setTurn(null)} onComment={onComment} /> : null}
    </>
  );
}
