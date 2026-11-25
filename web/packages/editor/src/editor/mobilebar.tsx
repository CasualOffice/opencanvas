// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

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
import { aiStore, openAssistant } from "../lib/assistant";
import { insertable, profileStore } from "./profile";
import { installedBlocks } from "../ext/model";
import { nothingToInsert, profileCtx } from "./insert/model";

export function MobileBar({ editor, role, onComment }: { editor: Editor; role: Role; onComment(id: string): void }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ focused: e.isFocused, sel: !e.state.selection.empty && !(e.state.selection instanceof NodeSelection) }),
  });
  // docs/prototypes/fixes-approved ToolbarClosed/ToolbarOpen (MOB-11): full width at the bottom,
  // clear of the home indicator (safe-area padding in CSS) with the keyboard closed; sitting on
  // the keyboard, without that padding, when it is open.
  const [kb, setKb] = useState(0);
  const turn = !!useStore(blockMenuStore);
  const ai = useStore(aiStore).on;
  // EDP-01: quick inserts follow the host's editor profile.
  const prof = useStore(profileStore);
  const can = (id: string) => insertable({ id }, prof);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const f = () => {
      const covered = Math.round(window.innerHeight - (vv.height + vv.offsetTop));
      setKb(covered > 60 ? covered : 0);
    };
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
      <div className={"mbar" + (kb ? " kb" : "")} role="toolbar" aria-label="Editing tools" style={{ bottom: kb }} onMouseDown={(e) => e.preventDefault()}>
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
            {ai ? (
              <button className="ai-ask" onClick={openAssistant}>
                <Ic name="sparkles" size={18} />
                Ask Assistant
              </button>
            ) : null}
          </>
        ) : edit ? (
          <>
            {!nothingToInsert(profileCtx(prof, installedBlocks())) && b("plus", "Insert block", () => insertBelowCaret(editor))}
            {b("type", "Turn into", openTurn)}
            {can("todo") && b("list-todo", "Checklist", () => editor.chain().focus().toggleTaskList().run(), editor.isActive("taskList"))}
            {can("bul") && b("list", "Bulleted list", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"))}
            {can("image") && b("image", "Image", () => editor.chain().focus().insertContent([{ type: "image", attrs: { src: "" } }, { type: "paragraph" }]).run())}
            {b("at-sign", "Mention someone", () => editor.chain().focus().insertContent("@").run())}
            <span className="sp" />
            {/* Prototypes ToolbarClosed/ToolbarOpen: with the keyboard open the last button hides
                it; with it closed it comments on the block with the caret. */}
            {kb
              ? b("chevron-down", "Hide keyboard", () => editor.commands.blur())
              : b("message-square-plus", "Comment", () => {
                  const t = topBlockAt(editor.state, editor.state.selection.from);
                  startComment(editor, role, onComment, t ? { from: t.pos + 1, to: t.pos + t.node.nodeSize - 1 } : undefined);
                })}
          </>
        ) : null}
      </div>
    </>
  );
}
