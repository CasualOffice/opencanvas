// Simple tables (WEB-02) with the editing machinery loaded on demand.
//
// The schema (node names `table/tableRow/tableHeader/tableCell` and their
// attrs, docs/15 §4) is defined up front so any document parses and renders at
// once. prosemirror-tables (cell selection, column resizing, Tab between cells,
// fixing ragged tables) is ~40 KB and only matters once someone works in a
// table, so it is registered as plugins after the editor starts (docs/02 §7).
import { Node, callOrReturn, getExtensionField, mergeAttributes, type Editor, type JSONContent } from "@tiptap/core";
import { TableRow } from "@tiptap/extension-table/row";
import { TableCell } from "@tiptap/extension-table/cell";
import { TableHeader } from "@tiptap/extension-table/header";

type TablesModule = typeof import("@tiptap/pm/tables");
let mod: Promise<TablesModule> | null = null;
let loaded: TablesModule | null = null;
const loadTables = () => (mod ??= import("@tiptap/pm/tables").then((m) => (loaded = m)));

const CELL_MIN = 80;

async function install(editor: Editor) {
  const t = await loadTables();
  if (editor.isDestroyed) return;
  // columnResizing must come before tableEditing (prosemirror-tables docs).
  editor.registerPlugin(t.columnResizing({ handleWidth: 5, cellMinWidth: CELL_MIN, defaultCellMinWidth: CELL_MIN, View: t.TableView, lastColumnResizable: true }));
  editor.registerPlugin(t.tableEditing({ allowTableNodeSelection: false }));
}

export const OcTable = Node.create({
  name: "table",
  content: "tableRow+",
  tableRole: "table",
  isolating: true,
  group: "block",
  parseHTML: () => [{ tag: "table" }],
  renderHTML: ({ HTMLAttributes }) => ["table", mergeAttributes(HTMLAttributes), ["tbody", 0]],
  onCreate() {
    void install(this.editor).catch(() => undefined);
  },
  addKeyboardShortcuts() {
    const go = (dir: 1 | -1) => () => {
      if (!loaded) return false;
      const { state, view } = this.editor;
      if (loaded.goToNextCell(dir)(state, view.dispatch)) return true;
      if (dir === 1 && loaded.isInTable(state) && loaded.addRowAfter(state, view.dispatch)) return loaded.goToNextCell(1)(this.editor.state, view.dispatch);
      return false;
    };
    return { Tab: go(1), "Shift-Tab": go(-1) };
  },
  // Same as @tiptap/extension-table: rows and cells read `tableRole` into their spec.
  extendNodeSchema(extension) {
    const context = { name: extension.name, options: extension.options, storage: extension.storage };
    return { tableRole: callOrReturn(getExtensionField(extension, "tableRole", context)) };
  },
});

export const TableNodes = [OcTable, TableRow, TableHeader, TableCell];

/** A rows × cols table with a header row, as Tiptap JSON. */
export function tableJSON(rows: number, cols: number): JSONContent {
  const cell = (type: string) => ({ type, content: [{ type: "paragraph" }] });
  return {
    type: "table",
    content: Array.from({ length: rows }, (_, r) => ({ type: "tableRow", content: Array.from({ length: cols }, () => cell(r === 0 ? "tableHeader" : "tableCell")) })),
  };
}
