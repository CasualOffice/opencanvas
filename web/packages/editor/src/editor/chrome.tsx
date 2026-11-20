// Desktop-only editing chrome: the block gutter (+ and drag grip) and the
// floating selection toolbar. Lazy-loaded: it brings drag-handle, bubble-menu
// and floating-ui, which phones and viewers never need.
import { useMemo, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { offset } from "@floating-ui/dom";
import { NodeSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import type { Anchor } from "../components/overlay";
import { BlockMenu, startComment } from "./blockmenu";

// ---------- block gutter: + and grip, with the block menu ----------

export function Gutter({ editor, onComment }: { editor: Editor; onComment(id: string): void }) {
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

// ---------- floating selection toolbar ----------

export function SelectionToolbar({ editor, role, onComment }: { editor: Editor; role: Role; onComment(id: string): void }) {
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

