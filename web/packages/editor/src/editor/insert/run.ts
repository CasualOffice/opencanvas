// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What each insert-menu entry inserts (INS-01). Existing / commands (slash.ts) do the work where
// they exist, so the old ids, their behaviour and their tests are unchanged; the new variants
// (callout styles, 4 columns and sidebar, database views, diagram types) are added here.
import type { Editor, JSONContent, Range } from "@tiptap/core";
import { bridge, docOf } from "../../lib/bridge";
import { loadBoard, loadDatabase } from "../blockdata";
import { columnsJSON, insertBlock, insertExtBlock, SLASH } from "../slash";
import type { Row } from "./model";
import { pickLiveBlock } from "../../live/state";

const slash = (id: string) => SLASH.find((x) => x.id === id)!;

const LEGACY: Record<string, string> = {
  text: "p", "heading:1": "h1", "heading:2": "h2", "heading:3": "h3", "list:bulleted": "bul", "list:numbered": "num", "list:checklist": "todo",
  quote: "quote", code: "code", link: "link", file: "file", table: "table", date: "date", csv: "csv", import: "import", board: "board", spreadsheet: "sheet", chart: "chart",
  image: "image", embed: "embed", "columns:2": "cols", "columns:3": "cols3", toggle: "toggle", divider: "divider", assistant: "assistant",
};

const CALLOUT: Record<string, { tone: string; icon: string }> = {
  info: { tone: "blue", icon: "info" },
  tip: { tone: "green", icon: "lightbulb" },
  warning: { tone: "amber", icon: "triangle-alert" },
  decision: { tone: "purple", icon: "circle-check" },
};

/** Diagram types without a board preset start blank (the shapes panel has every library). */
const DIAGRAM_PRESET: Record<string, "flowchart" | "mindmap" | "blank"> = { flowchart: "flowchart", mindmap: "mindmap" };

/**
 * Inserts a block whose package loads first. The position is taken before the await and mapped
 * through every transaction meanwhile (a collaborator's edit, or the block's own Y.Doc write
 * syncing back), so the block lands where the "/" was, not wherever the selection ended up.
 */
export function later(editor: Editor, range: Range | null, make: () => Promise<JSONContent[]>): Promise<void> {
  if (range) editor.chain().focus().deleteRange(range).run();
  let pos = editor.state.selection.from;
  const track = ({ transaction }: { transaction: { mapping: { map(p: number, assoc?: number): number } } }) => {
    pos = transaction.mapping.map(pos, -1);
  };
  editor.on("transaction", track);
  return make()
    .then((node) => {
      editor.off("transaction", track);
      editor.chain().focus().insertContentAt(Math.min(pos, editor.state.doc.content.size), node).run();
    })
    .catch(() => {
      editor.off("transaction", track);
      bridge.env.toast("That block couldn't load. Check your connection and try again.");
    });
}

/** Inserts a row's block with its shown variant where the "/" was (or at the selection). */
export function runRow(editor: Editor, range: Range | null, row: Row): void {
  const b = row.block;
  if (b.ext) return insertExtBlock(editor, range, b.ext);
  if (b.key === "live") return pickLiveBlock(editor, range);
  const key = b.key + (row.variant ? ":" + row.variant.id : "");
  const legacy = LEGACY[key] ?? LEGACY[b.key];
  if (legacy) return slash(legacy).run(editor, range);
  const v = row.variant?.id ?? "";
  if (b.key === "callout") {
    const c = CALLOUT[v] ?? CALLOUT.info;
    let ch = editor.chain().focus();
    if (range) ch = ch.deleteRange(range);
    ch.setParagraph().wrapIn("callout", c).run();
    return;
  }
  if (b.key === "columns") {
    const n: JSONContent = v === "sidebar" ? { ...columnsJSON(2), attrs: { widths: "25,75" } } : columnsJSON(4);
    return insertBlock(editor, range, n);
  }
  if (b.key === "database")
    return void later(editor, range, async () => {
      const d = await loadDatabase();
      const doc = docOf(editor);
      const id = d.createDatabase(doc, "blank");
      if (v && v !== "table") doc.transact(() => d.getDbMap(doc, id)?.set("view", v), d.DB_ORIGIN);
      return [{ type: "database", attrs: { dbId: id } }, { type: "paragraph" }];
    });
  if (b.key === "diagram")
    return void later(editor, range, async () => [{ type: "board", attrs: { boardId: (await loadBoard()).createBoard(docOf(editor), DIAGRAM_PRESET[v] ?? "blank") } }, { type: "paragraph" }]);
}
