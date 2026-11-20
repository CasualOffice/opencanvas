// Block menu (turn into, duplicate, comment, move, delete) and starting a
// comment from a selection. Shared by the desktop gutter (lazy chrome.tsx)
// and the mobile bar.
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type * as Y from "yjs";
import type { Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { bridge } from "../lib/bridge";
import { createThread, newThreadId } from "../lib/comments";
import { toast } from "../lib/store";
import { Popover, type Anchor } from "../components/overlay";
import { TURN, currentKind, turnInto } from "./slash";

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

