// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// "Make live" (LIVE-03, frames 1b, 1c and 6c): one short dialog; the host creates the file and
// decides its folder and people; the result is one step with Undo in the toast. Lazy.
import { useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Folder, ListChecks, Users, Radio, Link } from "lucide-react";
import { ICONS, Ic } from "../icons";
import { bridge } from "../lib/bridge";
import { toast } from "../lib/store";
import { Modal, ModalHead } from "../components/overlay";
import { ensureBlockIdAt } from "../editor/blockId";
import { LiveError, makeLive } from "./api";
import { copyBlockLink, makeGone, makeStore, mayAddRef } from "./state";
import "./live.css";

Object.assign(ICONS, { folder: Folder, "list-checks": ListChecks, users: Users, radio: Radio, link: Link });

/** The top-level blocks "Make live" moves: the one the menu is for (by its id, so a position
 *  that moved since the menu opened cannot pick another block), widened to the other top-level
 *  blocks of a text selection that spans it. */
export function pickedBlocks(editor: Editor, pos: number, blockId?: string | null): { pos: number; node: PMNode }[] {
  const { doc, selection } = editor.state;
  let at = -1;
  doc.forEach((n, off) => {
    if (at < 0 && (blockId ? n.attrs.blockId === blockId : off <= pos && pos < off + n.nodeSize)) at = off;
  });
  if (at < 0) return [];
  const node = doc.child(doc.resolve(at).index(0));
  const spans = !selection.empty && selection.$from.depth > 0 && selection.$to.depth > 0 && selection.from <= at + node.nodeSize && selection.to >= at;
  if (!spans) return [{ pos: at, node }];
  const out: { pos: number; node: PMNode }[] = [];
  doc.forEach((n, off) => {
    if (off + n.nodeSize > Math.min(selection.from, at) && off < Math.max(selection.to, at + 1)) out.push({ pos: off, node: n });
  });
  return out;
}

/** The nearest heading above the first block: the name's default (1b). */
function nearestHeading(editor: Editor, pos: number): string {
  let name = "";
  editor.state.doc.forEach((n, off) => {
    if (off < pos && n.type.name === "heading") name = n.textContent.trim();
  });
  return name.slice(0, 200);
}

const ALLOWED = new Set(["liveBlock", "blockRef", "extBlock"]);

export function canMakeLive(nodes: PMNode[]): string | null {
  let bad: string | null = null;
  for (const n of nodes) {
    n.descendants((c) => {
      if (ALLOWED.has(c.type.name)) bad = c.type.name === "extBlock" ? "SDK blocks can’t be made live yet." : "Live blocks can’t contain other live blocks.";
      return !bad;
    });
    if (ALLOWED.has(n.type.name)) bad = n.type.name === "extBlock" ? "SDK blocks can’t be made live yet." : "Live blocks can’t contain other live blocks.";
  }
  return bad;
}

export default function MakeLive({ editor, pos, blockId }: { editor: Editor; pos: number; blockId?: string | null }) {
  const blocks = useRef(pickedBlocks(editor, pos, blockId));
  const [name, setName] = useState(() => nearestHeading(editor, blocks.current[0]?.pos ?? pos) || "Live block");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef("mk_" + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const host = bridge.session?.host?.name || "your app";
  const canvas = bridge.session?.file?.name || "this canvas";
  const n = blocks.current.length;
  const close = () => makeStore.set(null);
  const what = (() => {
    const kinds = new Set(blocks.current.map((b) => b.node.type.name));
    if (n === 1 && kinds.has("database")) return "this database";
    if (n === 1 && kinds.has("board")) return "this whiteboard";
    if (n === 1 && kinds.has("taskList")) {
      const items = blocks.current[0].node.childCount;
      return `${items} checklist ${items === 1 ? "item" : "items"}`;
    }
    return `${n} ${n === 1 ? "block" : "blocks"}`;
  })();

  const submit = async () => {
    const nm = name.trim();
    if (!nm) return setErr("Give the live block a name.");
    const bad = canMakeLive(blocks.current.map((b) => b.node));
    if (bad) return setErr(bad);
    if (!mayAddRef(editor)) return;
    setBusy(true);
    setErr(null);
    // Stamp ids the server can find, and keep the blocks for Undo.
    const before: JSONContent[] = [];
    const ids: string[] = [];
    let stamped = false;
    for (const b of [...blocks.current].reverse()) {
      const had = b.node.attrs.blockId;
      const id = ensureBlockIdAt(editor, b.pos + 1);
      if (!id) continue;
      stamped ||= !had;
      ids.unshift(id);
    }
    for (const b of pickedBlocksById(editor, ids)) before.push(b.toJSON() as JSONContent);
    if (ids.length !== n) {
      setBusy(false);
      return setErr("These blocks can’t be made live.");
    }
    // A new id reaches the server with the next frame.
    if (stamped) await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await makeLive(ids, nm, key.current);
      close();
      toast(`${nm} is live`, {
        icon: "radio",
        ms: 8000,
        action: {
          label: "Undo",
          run: () => undo(editor, r.blockId, before),
        },
      });
      void copyBlockLink;
    } catch (e) {
      setBusy(false);
      if (e instanceof LiveError && e.kind === "unsupported") {
        makeGone.set(true);
        setErr(`${host} can’t create live blocks.`);
      } else if (e instanceof LiveError && e.kind === "network") setErr(`Couldn’t reach ${host}. Nothing changed. Try again.`);
      else setErr(`${host} couldn’t create the live block. Nothing changed.`);
    }
  };

  return (
    <Modal onClose={busy ? () => undefined : close} label="Make this a live block">
      <ModalHead title="Make this a live block" sub={`A live block can be shown in other canvases and in ${host}. Edits anywhere show up everywhere.`} icon="radio" tone="green" onClose={busy ? undefined : close} />
      <form
        className="mbd"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="lb-field">
          Name
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-autofocus disabled={busy} />
        </label>
        <div className="lb-facts">
          <p>
            <Ic name="folder" size={15} />
            <span>Saved as a file next to this canvas, in {host}.</span>
          </p>
          <p>
            <Ic name="users" size={15} />
            <span>
              Starts with the same people as <b>{canvas}</b>. Change who can see it in {host}.
            </span>
          </p>
          <p>
            <Ic name="list-checks" size={15} />
            <span>Moves {what} into the live block. They stay where they are on this page.</span>
          </p>
        </div>
        {err ? (
          <p className="lb-err" role="alert">
            {err}
          </p>
        ) : null}
        <div className="mft" style={{ padding: "1rem 0 0" }}>
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? <Ic name="loader-circle" size={14} className="spin" /> : null}
            Make live
          </button>
        </div>
      </form>
    </Modal>
  );
}

function pickedBlocksById(editor: Editor, ids: string[]): PMNode[] {
  const out: PMNode[] = [];
  editor.state.doc.forEach((n) => {
    if (ids.includes(n.attrs.blockId as string)) out.push(n);
  });
  return out;
}

/** Undo (1c): the plain blocks go back; the host file stays, since the host owns it. */
function undo(editor: Editor, liveBlockId: string, before: JSONContent[]) {
  let at = -1;
  let size = 0;
  editor.state.doc.forEach((n, off) => {
    if (n.type.name === "liveBlock" && n.attrs.blockId === liveBlockId) {
      at = off;
      size = n.nodeSize;
    }
  });
  if (at < 0) return toast("The live block isn’t here any more.", { icon: "triangle-alert" });
  editor.chain().focus().insertContentAt({ from: at, to: at + size }, before).run();
}
