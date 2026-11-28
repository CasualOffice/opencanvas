// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Desktop-only editing chrome: the block gutter (+ and drag grip) and the
// floating selection toolbar. Lazy-loaded: it brings drag-handle, bubble-menu
// and floating-ui, which phones and viewers never need.
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../components/overlay";
import { ColorPicker } from "./pickers";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { offset, type Middleware } from "@floating-ui/dom";
import { NodeSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { keyLabel, isMac } from "../lib/keys";
import { useStore } from "../lib/store";
import { startComment } from "./blockmenu";
import { blockMenuStore, insertBelow } from "./blockops";
import { linkStore, openLinkEditor } from "./linkstate";
import { aiStore, aiUiStore, openAssistant } from "../lib/assistant";
import { profileStore } from "./profile";
import { installedBlocks } from "../ext/model";
import { nothingToInsert, profileCtx } from "./insert/model";

// ---------- block gutter: + and grip, with the block menu ----------

export function Gutter({ editor }: { editor: Editor }) {
  const cur = useRef<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });
  const pos = useMemo(() => {
    // Database and board blocks break out of the text column (`.wideblock`): put the handle at
    // the wide block's own left edge, not the text column's, where it would cover the block.
    const atWideEdge: Middleware = {
      name: "atWideEdge",
      fn({ x }) {
        const p = cur.current.pos;
        const dom = p >= 0 ? (editor.view.nodeDOM(p) as HTMLElement | null) : null;
        const wide = dom?.querySelector?.(".wideblock");
        if (!dom || !wide) return {};
        const dx = wide.getBoundingClientRect().left - dom.getBoundingClientRect().left;
        return dx < 0 ? { x: x + dx } : {};
      },
    };
    // mainAxis 0: the handle touches the text; its 6px spacing is padding inside `.gut`, so the
    // pointer never crosses a gap that counts as leaving the editor (which hides the handle).
    return { placement: "left-start" as const, strategy: "absolute" as const, middleware: [offset({ mainAxis: 0, crossAxis: 3 }), atWideEdge] };
  }, [editor]);
  const menu = useStore(blockMenuStore);
  // INS-01 (5d): with nothing but Text to insert, no "+".
  const plus = !nothingToInsert(profileCtx(useStore(profileStore), installedBlocks()));
  // Keep the handle on its block while the menu is open; release it after.
  useEffect(() => {
    editor.commands.setMeta("lockDragHandle", !!menu);
  }, [editor, menu]);

  return (
    <DragHandle editor={editor} computePositionConfig={pos} onNodeChange={({ node, pos }) => (cur.current = { node, pos })}>
      <div className="gut">
        {plus ? <button
          title="Insert below"
          aria-label="Insert block below"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const { node, pos } = cur.current;
            if (!node) return;
            insertBelow(editor, pos, node);
          }}
        >
          <Ic name="plus" size={15} />
        </button> : null}
        <button
          className="grip"
          title={`Drag to move, click for options (${keyLabel("Mod-/")})`}
          aria-label="Block options"
          aria-haspopup="menu"
          onClick={(e) => {
            const { node, pos } = cur.current;
            if (!node) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            blockMenuStore.set({ pos, node, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
          }}
        >
          <Ic name="grip-vertical" size={15} />
        </button>
      </div>
    </DragHandle>
  );
}

// ---------- floating selection toolbar ----------

export function SelectionToolbar({ editor, role, onComment }: { editor: Editor; role: Role; onComment(id: string): void }) {
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
      color: (e.getAttributes("textColor").color as string | undefined) ?? null,
    }),
  });
  const [colors, setColors] = useState<HTMLElement | null>(null);
  const linkOpen = !!useStore(linkStore);
  const ai = useStore(aiStore).on;
  const edit = role === "edit";
  const btn = (key: Exclude<keyof typeof st, "color">, icon: string, label: string, keys: string | null, run: () => void) => {
    const full = keys ? `${label} (${keyLabel(keys)})` : label;
    return (
      <button className={"ib" + (st[key] ? " on" : "")} title={full} aria-label={label} aria-keyshortcuts={keys ? keys.replace("Mod", isMac ? "Meta" : "Control").replace(/-/g, "+") : undefined} aria-pressed={st[key]} onClick={run}>
        <Ic name={icon} />
      </button>
    );
  };
  return (
    <BubbleMenu
      editor={editor}
      className="ftb"
      updateDelay={0}
      options={{ placement: "top", offset: 8, flip: true }}
      shouldShow={({ editor: e, state, from, to }) => {
        if (from === to || state.selection instanceof NodeSelection) return false;
        if (!e.isFocused || linkOpen || aiUiStore.get()) return false;
        const $f = state.selection.$from;
        if ($f.parent.type.spec.code) return false;
        return true;
      }}
    >
      <div role="toolbar" aria-label="Text formatting" style={{ display: "flex", alignItems: "center", gap: 1 }} onMouseDown={(e) => e.preventDefault()}>
        {edit ? (
          <>
            <button
              className="tsel"
              aria-haspopup="menu"
              onClick={(e) => {
                const $f = editor.state.selection.$from;
                const p = $f.before(1);
                const node = editor.state.doc.nodeAt(p);
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                if (node) blockMenuStore.set({ pos: p, node, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
              }}
            >
              Turn into
              <Ic name="chevron-down" size={12} />
            </button>
            <span className="vs" />
            {btn("bold", "bold", "Bold", "Mod-b", () => editor.chain().focus().toggleBold().run())}
            {btn("italic", "italic", "Italic", "Mod-i", () => editor.chain().focus().toggleItalic().run())}
            {btn("underline", "underline", "Underline", "Mod-u", () => editor.chain().focus().toggleUnderline().run())}
            {btn("strike", "strikethrough", "Strikethrough", "Mod-Shift-s", () => editor.chain().focus().toggleStrike().run())}
            {btn("code", "code-xml", "Inline code", "Mod-e", () => editor.chain().focus().toggleCode().run())}
            {btn("mark", "highlighter", "Highlight", "Mod-Shift-h", () => editor.chain().focus().toggleHighlight().run())}
            <button
              className={"ib tcbtn" + (st.color ? ` on tc-${st.color}` : "")}
              title="Text colour"
              aria-label={st.color ? `Text colour: ${st.color}` : "Text colour"}
              aria-haspopup="dialog"
              aria-expanded={!!colors}
              onClick={(e) => setColors(colors ? null : e.currentTarget)}
            >
              <Ic name="baseline" />
            </button>
            {btn("link", "link", "Link", "Mod-k", () => openLinkEditor(editor))}
            <span className="vs" />
          </>
        ) : null}
        <button className="ib" title="Comment" aria-label="Comment" onClick={() => startComment(editor, role, onComment)}>
          <Ic name="message-square-plus" />
        </button>
        {ai ? (
          <>
            <span className="vs" />
            <button className="ai-ask" onClick={openAssistant} aria-keyshortcuts={isMac ? "Meta+J" : "Control+J"}>
              <Ic name="sparkles" />
              Ask Assistant
              <span className="ai-kbd" aria-hidden="true">{isMac ? "⌘J" : "Ctrl+J"}</span>
            </button>
          </>
        ) : null}
      </div>
      {colors ? (
        <Popover anchor={colors} onClose={() => setColors(null)} title="Text colour" kind="dialog" autoFocus={false} noSheet>
          <div onMouseDown={(e) => e.preventDefault()}>
            <ColorPicker
              current={st.color}
              onPick={(c) => {
                setColors(null);
                const ch = editor.chain().focus();
                (c ? ch.setTextColor(c) : ch.unsetTextColor()).run();
              }}
            />
          </div>
        </Popover>
      ) : null}
    </BubbleMenu>
  );
}
