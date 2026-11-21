import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BASE_EXTENSIONS } from "./base";
import { mentionNode } from "./link";
import { BlockId } from "./blockId";
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TaskItem } from "@tiptap/extension-list/task-item";
import { TaskList } from "@tiptap/extension-list/task-list";
import { TableNodes } from "./table";
import Highlight from "@tiptap/extension-highlight";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Extension } from "@tiptap/core";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { OcUser, Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { bridge } from "../lib/bridge";

import { bookmarkNode, hostOf, resolveEmbed } from "../lib/embeds";
import { createStore, useStore } from "../lib/store";
import { insertUploads } from "../lib/uploads";
import { loadBoard, loadDatabase } from "./blockdata";
import { Popover, useShell } from "../components/overlay";
import { ColumnTools } from "./columns";
import { Board, Bookmark, Callout, CommentMark, Column, Columns, Database, Embed, FileAttachment, OcCodeBlock, OcImage, Toggle, ToggleContent, ToggleSummary } from "./nodes";
import type { SlashItem } from "./slash";

const Gutter = lazy(() => import("./chrome").then((m) => ({ default: m.Gutter })));
const BlockMenu = lazy(() => import("./blockmenu").then((m) => ({ default: m.BlockMenu })));
const LinkPopover = lazy(() => import("./linkpop").then((m) => ({ default: m.LinkPopover })));
const TableMenu = lazy(() => import("./tablemenu").then((m) => ({ default: m.TableMenu })));
const MobileBar = lazy(() => import("./mobilebar").then((m) => ({ default: m.MobileBar })));
const SelectionToolbar = lazy(() => import("./chrome").then((m) => ({ default: m.SelectionToolbar })));
import { dismissSuggest, suggestStore } from "./suggest";
import { blockMenuStore, duplicateBlock, moveBlock, openBlockMenuAtCaret, topBlockAt } from "./blockops";
import { linkStore, openLinkActions, openLinkEditor } from "./linkstate";
import { postToHost } from "../lib/host";
import { readableOn } from "../lib/color";
import { tableStore, trackTable } from "./tablestate";

export interface EditorProps {
  doc: Y.Doc;
  awareness: Awareness;
  role: Role;
  me: OcUser;
  users: OcUser[];
  searchUsers(q: string): Promise<OcUser[]>;
  onReady(e: Editor | null): void;
  onComment(threadId: string): void;
  /** Quick starts shown under an empty canvas (templates, database, whiteboard, import). */
  emptyState?: EmptyAction[];
}

export interface EmptyAction {
  id: string;
  icon: string;
  label: string;
  run(): void;
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

// ---------- paste / drop files → upload (WEB-03) ----------

const FileDrop = Extension.create({
  name: "fileDrop",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("fileDrop"),
        props: {
          handlePaste(_view, event) {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length || !editor.isEditable) return false;
            return insertUploads(editor, files);
          },
          handleDrop(view, event, _slice, moved) {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (moved || !files.length || !editor.isEditable) return false;
            event.preventDefault();
            let pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (pos !== undefined) {
              // Drop between blocks, not inside a word.
              const $p = view.state.doc.resolve(pos);
              if ($p.depth > 0) pos = $p.after(1);
            }
            return insertUploads(editor, files, pos);
          },
        },
      }),
    ];
  },
});

// ---------- keyboard: ⌘K link, ⌘/ block menu, ⌘D duplicate, ⌘⇧↑/↓ move; clicks on links and mentions ----------

const EditorKeys = Extension.create({
  name: "ocKeys",
  addKeyboardShortcuts() {
    const e = this.editor;
    const block = () => (e.isEditable ? topBlockAt(e.state, e.state.selection.from) : null);
    return {
      "Mod-k": () => openLinkEditor(e),
      "Mod-/": () => e.isEditable && openBlockMenuAtCaret(e),
      "Mod-d": () => {
        const b = block();
        return b ? duplicateBlock(e, b.pos, b.node) : false;
      },
      "Mod-Shift-ArrowUp": () => {
        const b = block();
        return b ? (moveBlock(e, b.pos, b.node, -1), true) : false;
      },
      "Mod-Shift-ArrowDown": () => {
        const b = block();
        return b ? (moveBlock(e, b.pos, b.node, 1), true) : false;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("ocClicks"),
        props: {
          handleClick(view, pos, event) {
            const t = event.target as HTMLElement | null;
            const mention = t?.closest?.(".mention[data-id]");
            if (mention) {
              postToHost("UI_Mention_Click", { id: mention.getAttribute("data-id") });
              return false;
            }
            const a = t?.closest?.("a[href]");
            if (!a || !view.dom.contains(a)) return false;
            const href = a.getAttribute("href") ?? "";
            if (!editor.isEditable) {
              // Read-only: the browser follows the link (target=_blank); tell the host too.
              postToHost("UI_Link_Click", { url: href });
              return false;
            }
            if (event.metaKey || event.ctrlKey) {
              postToHost("UI_Link_Click", { url: href });
              window.open(href, "_blank", "noopener,noreferrer");
              return true;
            }
            // Let the caret land first, then offer open / edit / copy / remove.
            window.setTimeout(() => openLinkActions(editor, pos), 0);
            return false;
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

const MentionNode = mentionNode(colorFor);

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
        ...BASE_EXTENSIONS,
        OcCodeBlock,
        BlockId,
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
            l.style.color = readableOn(u.color);
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
        ...TableNodes,
        Highlight,
        Placeholder.configure({
          includeChildren: true,
          showOnlyCurrent: true,
          placeholder: ({ node }) =>
            node.type.name === "heading" ? "Heading" : node.type.name === "toggleSummary" ? "Toggle" : "Type '/' for blocks",
        }),
        MentionNode,
        Callout,
        Toggle,
        ToggleSummary,
        ToggleContent,
        Columns,
        Column,
        ColumnTools,
        Bookmark,
        Embed,
        FileAttachment,
        OcImage,
        Database,
        Board,
        CommentMark,
        FileDrop,
        PasteUrl,
        EditorKeys,
      ],
    },
    [p.doc],
  );

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  // Slash menu, @mentions, autolink and link-on-paste: plugins only, right after first paint.
  useEffect(() => {
    let off = false;
    const t = window.setTimeout(() => {
      void import("./late")
        .then((m) => {
          if (!off) m.installLate(editor, async (q) => (await searchRef.current(q)).slice(0, 8).map((u) => ({ id: u.id, label: u.name, color: u.color })));
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
  }, [editor]);

  // Warm the database/board chunks once the page is idle so inserting one is instant.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void loadDatabase().catch(() => undefined);
      void loadBoard().catch(() => undefined);
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

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

  // Table tools follow the caret into a table (WEB-02).
  useEffect(() => trackTable(editor), [editor]);

  const menu = useStore(blockMenuStore);
  const link = useStore(linkStore);
  const table = useStore(tableStore);
  useEffect(() => {
    // Read-only now (role change, conflict): close editing popovers.
    if (!editable) {
      blockMenuStore.set(null);
      linkStore.set(null);
    }
  }, [editable]);

  return (
    <>
      <EditorContent editor={editor} />
      {editable && p.emptyState ? <EmptyState editor={editor} actions={p.emptyState} /> : null}
      <Suspense fallback={null}>
        {editable && !compact ? <Gutter editor={editor} /> : null}
        {!compact && p.role !== "view" ? <SelectionToolbar editor={editor} role={p.role} onComment={p.onComment} /> : null}
        {menu && editable ? (
          <BlockMenu
            editor={editor}
            anchor={new DOMRect(menu.rect.left, menu.rect.top, Math.max(1, menu.rect.right - menu.rect.left), menu.rect.bottom - menu.rect.top)}
            node={menu.node}
            pos={menu.pos}
            onClose={() => blockMenuStore.set(null)}
            onComment={p.onComment}
          />
        ) : null}
        {link && editable ? <LinkPopover editor={editor} edit={link} /> : null}
        {table && editable ? <TableMenu editor={editor} at={table} /> : null}
      </Suspense>
      <SuggestMenu editor={editor} />
      <PasteMenu editor={editor} />
      <PeerBars editor={editor} awareness={p.awareness} />
      <Suspense fallback={null}>{compact && p.role !== "view" && root ? <MobileBar editor={editor} role={p.role} onComment={p.onComment} /> : null}</Suspense>
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
      <Popover anchor={s.rect} onClose={close} title="Mention" minWidth={240} kind="listbox">
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
      <Popover anchor={s.rect} onClose={close} title="Insert" kind="listbox">
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
    <Popover anchor={s.rect} onClose={close} title="Insert" minWidth={300} kind="listbox">
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
    <Popover anchor={o.rect} onClose={close} title="Paste link" minWidth={200} autoFocus={false}>
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


// ---------- empty canvas: an invitation instead of a blank page ----------

function EmptyState({ editor, actions }: { editor: Editor; actions: EmptyAction[] }) {
  const empty = useEditorState({ editor, selector: ({ editor: e }) => e.isEmpty });
  if (!empty) return null;
  return (
    <div className="empty-start" role="group" aria-label="Start this canvas">
      <p>
        Type, or press <kbd>/</kbd> for blocks. Or start with
      </p>
      <div className="chips">
        {actions.map((a) => (
          <button key={a.id} className="chip" onClick={a.run}>
            <Ic name={a.icon} size={15} />
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
