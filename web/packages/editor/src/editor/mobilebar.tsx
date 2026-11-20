// Phone editing toolbar that sits above the keyboard. Lazy: desktop never needs it.
import { useEffect, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { BlockMenu, startComment } from "./blockmenu";

export function MobileBar({ editor, role, onComment }: { editor: Editor; role: Role; onComment(id: string): void }) {
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
