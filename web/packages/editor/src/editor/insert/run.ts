// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What each insert-menu entry inserts (INS-01). Existing / commands (slash.ts) do the work where
// they exist, so the old ids, their behaviour and their tests are unchanged; the new variants
// (callout styles, 4 columns and sidebar, database views, diagram types) are added here.
import type { Editor, JSONContent, Range } from "@tiptap/core";
import { bridge } from "../../lib/bridge";
import { loadBoard, loadDatabase } from "../blockdata";
import { columnsJSON, insertBlock, insertExtBlock, SLASH } from "../slash";
import type { Row } from "./model";

const slash = (id: string) => SLASH.find((x) => x.id === id)!;

const LEGACY: Record<string, string> = {
  text: "p", "heading:1": "h1", "heading:2": "h2", "heading:3": "h3", "list:bulleted": "bul", "list:numbered": "num", "list:checklist": "todo",
  quote: "quote", code: "code", link: "link", file: "file", table: "table", date: "date", csv: "csv", import: "import", board: "board",
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

function later(editor: Editor, range: Range | null, make: () => Promise<JSONContent[]>) {
  if (range) editor.chain().focus().deleteRange(range).run();
  make()
    .then((node) => editor.chain().focus().insertContent(node).run())
    .catch(() => bridge.env.toast("That block couldn't load. Check your connection and try again."));
}

/** Inserts a row's block with its shown variant where the "/" was (or at the selection). */
export function runRow(editor: Editor, range: Range | null, row: Row): void {
  const b = row.block;
  if (b.ext) return insertExtBlock(editor, range, b.ext);
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
    return later(editor, range, async () => {
      const d = await loadDatabase();
      const id = d.createDatabase(bridge.doc, "blank");
      if (v && v !== "table") bridge.doc.transact(() => d.getDbMap(bridge.doc, id)?.set("view", v), d.DB_ORIGIN);
      return [{ type: "database", attrs: { dbId: id } }, { type: "paragraph" }];
    });
  if (b.key === "diagram")
    return later(editor, range, async () => [{ type: "board", attrs: { boardId: (await loadBoard()).createBoard(bridge.doc, DIAGRAM_PRESET[v] ?? "blank") } }, { type: "paragraph" }]);
}
