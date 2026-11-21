// Phone editing toolbar that sits above the keyboard. Lazy: desktop never needs it.
import { useEffect, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import type { Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { useStore } from "../lib/store";
import { startComment } from "./blockmenu";
import { blockMenuStore, insertBelowCaret, topBlockAt } from "./blockops";
import { openLinkEditor } from "./linkstate";

export function MobileBar({ editor, role, onComment }: { editor: Editor; role: Role; onComment(id: string): void }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ focused: e.isFocused, sel: !e.state.selection.empty && !(e.state.selection instanceof NodeSelection) }),
  });
  const [bottom, setBottom] = useState(8);
  const turn = !!useStore(blockMenuStore);
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
  const openTurn = () => {
    const b = topBlockAt(editor.state, editor.state.selection.from);
    if (b) blockMenuStore.set({ pos: b.pos, node: b.node, rect: { left: 0, right: 0, top: 0, bottom: 0 } });
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
                {b("link", "Link", () => openLinkEditor(editor), editor.isActive("link"))}
                <span className="vs" />
              </>
            ) : null}
            {b("message-square-plus", "Comment", () => startComment(editor, role, onComment))}
          </>
        ) : edit ? (
          <>
            {b("plus", "Insert block", () => insertBelowCaret(editor))}
            {b("type", "Turn into", openTurn)}
            {b("list-todo", "Checklist", () => editor.chain().focus().toggleTaskList().run(), editor.isActive("taskList"))}
            {b("list", "Bulleted list", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"))}
            {b("image", "Image", () => editor.chain().focus().insertContent([{ type: "image", attrs: { src: "" } }, { type: "paragraph" }]).run())}
            {b("at-sign", "Mention someone", () => editor.chain().focus().insertContent("@").run())}
            <span className="vs" />
            {b("keyboard", "Done editing", () => editor.commands.blur())}
          </>
        ) : null}
      </div>
    </>
  );
}
