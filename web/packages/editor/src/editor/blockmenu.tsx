// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Block menu (turn into, colour, columns, duplicate, link, comment, move,
// delete) and starting a comment from a selection. Opened from the desktop
// gutter, ⌘/ at the caret, the selection toolbar's "Turn into" and the phone bar.
// Lazy: loads on first use.
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import { bridge } from "../lib/bridge";
import { createThread, newThreadId } from "../lib/comments";
import { postToHost } from "../lib/host";
import { keyLabel } from "../lib/keys";
import { toast } from "../lib/store";
import { Popover, type Anchor } from "../components/overlay";
import { deleteBlock, duplicateBlock, indexAt, moveBlock } from "./blockops";
import { TURN, kindOfNode, turnInto } from "./slash";
import { featureOn, insertable } from "./profile";
import { fileActions } from "./files/actions";
import { newBlockId } from "./blockId";
import { addColumn, MAX_COLUMNS, MIN_COLUMNS, setColumnTitles } from "./columns";
import { FILE_EVENT, fileDisplay, fileKind, hasBytes } from "./files/kind";
import { EXT_ACTION, blockTitle, type ExtAttrs } from "../ext/model";

// ---------- comments from the editor ----------

export function startComment(editor: Editor, role: Role, onComment: (id: string) => void, range?: { from: number; to: number }) {
  const { from, to } = range ?? editor.state.selection;
  const quote = editor.state.doc.textBetween(from, to, " ").trim();
  // EDP-01: `[host.editor.features] comments = false`: no new threads (existing ones stay).
  if (!featureOn("comments")) return toast("Comments are off here", { icon: "message-square-plus" });
  if (!quote) return toast("Select some text to comment on", { icon: "message-square-plus" });
  const id = newThreadId();
  createThread(bridge.doc, id, quote);
  if (role === "edit") editor.chain().setTextSelection({ from, to }).setMark("commentMark", { threadId: id }).run();
  // The comment box takes focus: the selection toolbar must not linger over the text.
  editor.commands.blur();
  onComment(id);
}

const TEXTY = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "callout"]);
const TONES = ["gray", "blue", "green", "amber", "red", "purple", "pink"] as const;

export { newBlockId } from "./blockId";

/** Gives the block a `blockId` (if it has none) and returns it. */
function ensureBlockId(editor: Editor, pos: number, node: PMNode): string | null {
  if (!("blockId" in node.attrs)) return null;
  const existing = node.attrs.blockId as string | null;
  if (existing) return existing;
  const id = newBlockId();
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: id }));
  return id;
}

export function BlockMenu({ editor, anchor, node, pos, onClose, onComment }: { editor: Editor; anchor: Anchor; node: PMNode; pos: number; onClose(): void; onComment(id: string): void }) {
  const texty = TEXTY.has(node.type.name);
  const selectInside = () => editor.chain().focus().setTextSelection(Math.min(pos + 1, editor.state.doc.content.size)).run();
  // From the node itself: selecting into the block here would pull focus back out of the menu.
  const kind = texty ? kindOfNode(node) : "";
  const run = (fn: () => void) => {
    onClose();
    fn();
  };
  const doc = editor.state.doc;
  const idx = indexAt(doc, pos);
  const isCols = node.type.name === "columns";
  const isCallout = node.type.name === "callout";
  const cols = isCols ? node.childCount : 0;
  const setColumns = (n: number) => {
    const s = editor.schema;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const cur = tr.doc.nodeAt(pos);
        if (!cur || cur.type.name !== "columns") return false;
        if (n > cur.childCount) {
          tr.insert(pos + cur.nodeSize - 1, s.nodes.column.create(null, s.nodes.paragraph.create()));
        } else if (n < cur.childCount && cur.childCount > 1) {
          // Fold the last column's content into the one before it: nothing is lost.
          const last = cur.child(cur.childCount - 1);
          const prev = cur.child(cur.childCount - 2);
          const lastStart = pos + cur.nodeSize - 1 - last.nodeSize;
          const prevEnd = lastStart - 1;
          const keep = last.content.childCount === 1 && last.content.firstChild?.content.size === 0 ? null : last.content;
          tr.delete(lastStart, lastStart + last.nodeSize);
          if (keep) tr.insert(prevEnd, keep);
          tr.setNodeMarkup(pos, undefined, { ...cur.attrs, widths: null });
          void prev;
        }
        return true;
      })
      .run();
  };
  const mod = (k: string) => keyLabel(k);
  return (
    <Popover anchor={anchor} onClose={onClose} title="Block" minWidth={240}>
      {texty ? (
        <>
          <div className="mh">Turn into</div>
          {TURN.filter(([id]) => id === kind || insertable({ id })).map(([id, icon, label]) => (
            <button key={id} className="mi" onClick={() => run(() => (selectInside(), turnInto(editor, id)))} aria-current={kind === id ? "true" : undefined}>
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
      {isCallout ? (
        <>
          <div className="mh">Colour</div>
          <div className="tones" role="group" aria-label="Callout colour">
            {TONES.map((t) => (
              <button
                key={t}
                className={`tone-${t}` + (node.attrs.tone === t ? " on" : "")}
                aria-label={t[0].toUpperCase() + t.slice(1)}
                aria-pressed={node.attrs.tone === t}
                onClick={() => run(() => editor.chain().focus().command(({ tr }) => (tr.setNodeMarkup(pos, undefined, { ...node.attrs, tone: t }), true)).run())}
              />
            ))}
          </div>
          <div className="msep" />
        </>
      ) : null}
      {node.type.name === "fileAttachment" ? (
        <>
          <div className="mh">File</div>
          {fileActions({
            kind: fileKind(node.attrs.mime, node.attrs.name),
            display: fileDisplay(node.attrs.display, fileKind(node.attrs.mime, node.attrs.name)),
            role: bridge.env?.role ?? "edit",
            editable: editor.isEditable,
            canDownload: bridge.session?.perms?.download !== false,
            hasFile: hasBytes(node.attrs.url) && !node.attrs.upload,
            inBlockMenu: true,
          }).map((a) => (
            <button
              key={a.id}
              className="mi"
              onClick={() =>
                run(() => {
                  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
                  dom?.querySelector(".filev")?.dispatchEvent(new CustomEvent(FILE_EVENT, { detail: a.id }));
                })
              }
            >
              <Ic name={a.icon} />
              {a.label}
            </button>
          ))}
          <div className="msep" />
        </>
      ) : null}
      {isCols ? (
        <>
          <div className="mh">Columns</div>
          <button className="mi" disabled={cols >= MAX_COLUMNS} onClick={() => run(() => addColumn(editor.view, pos, cols))}>
            <Ic name="columns-3" />
            Add a column
          </button>
          <button className="mi" disabled={cols <= MIN_COLUMNS} onClick={() => run(() => setColumns(cols - 1))}>
            <Ic name="columns-2" />
            Remove the last column
          </button>
          {node.firstChild?.attrs.title != null ? (
            <button className="mi" onClick={() => run(() => setColumnTitles(editor, pos, false))}>
              <Ic name="heading-3" />
              Remove column titles
            </button>
          ) : (
            <button className="mi" onClick={() => run(() => setColumnTitles(editor, pos, true))}>
              <Ic name="heading-3" />
              Add column title
            </button>
          )}
          <div className="msep" />
        </>
      ) : null}
      {node.type.name === "extBlock" ? (
        <>
          <div className="mh">{blockTitle(node.attrs as ExtAttrs)}</div>
          <button className="mi" onClick={() => run(() => (editor.view.nodeDOM(pos) as HTMLElement | null)?.dispatchEvent(new CustomEvent(EXT_ACTION, { detail: "about" })))}>
            <Ic name="info" />
            About this block
          </button>
          <button className="mi" onClick={() => run(() => (editor.view.nodeDOM(pos) as HTMLElement | null)?.dispatchEvent(new CustomEvent(EXT_ACTION, { detail: "reload" })))}>
            <Ic name="rotate-ccw" />
            Reload block
          </button>
          <div className="msep" />
        </>
      ) : null}
      <button className="mi" onClick={() => run(() => duplicateBlock(editor, pos, node))}>
        <Ic name="copy" />
        Duplicate
        <span className="mk">{mod("Mod-d")}</span>
      </button>
      <button
        className="mi"
        onClick={() =>
          run(() => {
            const id = ensureBlockId(editor, pos, node);
            if (!id) return toast("This block can't be linked", { icon: "link" });
            // The host owns URLs (docs/05 §4): it gets the block id and builds its own link;
            // `Action_ScrollToBlock` brings a reader back here.
            // `UI_BlockLink` (docs/05 §4); `UI_Block_Link` is the name hosts built against first.
            const values = { fileId: bridge.session?.file?.id ?? null, blockId: id };
            postToHost("UI_BlockLink", values);
            postToHost("UI_Block_Link", values);
            const url = new URL(window.location.href);
            url.hash = "";
            const link = bridge.session?.demo ? `${url.toString()}#demo&block=${id}` : `#block=${id}`;
            void navigator.clipboard?.writeText(link).catch(() => undefined);
            toast(bridge.session?.demo ? "Link to block copied" : "Block link copied. Paste it in a comment or a message.", { icon: "link" });
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
            else if (node.type.name === "extBlock") {
              // Decision 5: a thread on the whole block. Its quote is the block's title and the
              // first line of its saved copy, so it reads well if the block later fails to load.
              const a = node.attrs as ExtAttrs;
              const bid = ensureBlockId(editor, pos, node);
              const first = (a.fallback?.text || a.fallback?.markdown || "").split("\n")[0].replace(/\\(.)/g, "$1").trim();
              const id = newThreadId();
              createThread(bridge.doc, id, first ? `${blockTitle(a)}: ${first}` : blockTitle(a), bid ?? undefined);
              onComment(id);
            } else {
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
      <button className="mi" disabled={idx <= 0} onClick={() => run(() => moveBlock(editor, pos, node, -1))}>
        <Ic name="arrow-up" />
        Move up
        <span className="mk">{mod("Mod-Shift-ArrowUp")}</span>
      </button>
      <button className="mi" disabled={idx < 0 || idx >= doc.childCount - 1} onClick={() => run(() => moveBlock(editor, pos, node, 1))}>
        <Ic name="arrow-down" />
        Move down
        <span className="mk">{mod("Mod-Shift-ArrowDown")}</span>
      </button>
      <div className="msep" />
      <button
        className="mi danger"
        onClick={() =>
          run(() => {
            deleteBlock(editor, pos, node);
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
