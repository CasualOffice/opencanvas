// Slash menu items (grouped, with tiles and markdown shortcuts) and block actions.
import type { Editor, JSONContent, Range } from "@tiptap/core";
import { insertUploads } from "../lib/uploads";
import { datePickStore, isoDate } from "./inline";
import { tableJSON } from "./table";
import { loadBoard, loadDatabase } from "./blockdata";
import { bridge } from "../lib/bridge";
import { bookmarkNode, hostOf, resolveEmbed } from "../lib/embeds";
import { aiStore, openAssistant } from "../lib/assistant";

export interface SlashItem {
  group: "Basic" | "Data" | "Media" | "Layout";
  id: string;
  icon: string;
  title: string;
  desc: string;
  md?: string;
  keywords?: string;
  run(editor: Editor, range: Range | null): void;
}

/** Like insertBlock, for blocks whose data model loads on demand: the slash text goes now, the block when ready. */
function insertLater(editor: Editor, range: Range | null, make: () => Promise<JSONContent | JSONContent[]>) {
  if (range) editor.chain().focus().deleteRange(range).run();
  make()
    .then((node) => editor.chain().focus().insertContent(node).run())
    .catch(() => bridge.env.toast("That block couldn't load. Check your connection and try again."));
}

/** Replaces the current (empty) block or inserts after it. */
export function insertBlock(editor: Editor, range: Range | null, node: JSONContent | JSONContent[]) {
  const c = editor.chain().focus();
  if (range) c.deleteRange(range);
  c.insertContent(node).run();
}

const setBlock = (editor: Editor, range: Range | null, fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
  let c = editor.chain().focus();
  if (range) c = c.deleteRange(range);
  fn(c).run();
};

export const SLASH: SlashItem[] = [
  { group: "Basic", id: "p", icon: "type", title: "Text", desc: "Just start writing", run: (e, r) => setBlock(e, r, (c) => c.setParagraph()) },
  { group: "Basic", id: "h1", icon: "heading-1", title: "Heading 1", desc: "Big section heading", md: "#", run: (e, r) => setBlock(e, r, (c) => c.setHeading({ level: 1 })) },
  { group: "Basic", id: "h2", icon: "heading-2", title: "Heading 2", desc: "Medium heading", md: "##", run: (e, r) => setBlock(e, r, (c) => c.setHeading({ level: 2 })) },
  { group: "Basic", id: "h3", icon: "heading-3", title: "Heading 3", desc: "Small heading", md: "###", run: (e, r) => setBlock(e, r, (c) => c.setHeading({ level: 3 })) },
  { group: "Basic", id: "todo", icon: "list-todo", title: "Checklist", desc: "Track tasks", md: "[]", keywords: "todo task", run: (e, r) => setBlock(e, r, (c) => c.toggleTaskList()) },
  { group: "Basic", id: "bul", icon: "list", title: "Bulleted list", desc: "Simple list", md: "-", run: (e, r) => setBlock(e, r, (c) => c.toggleBulletList()) },
  { group: "Basic", id: "num", icon: "list-ordered", title: "Numbered list", desc: "Ordered steps", md: "1.", run: (e, r) => setBlock(e, r, (c) => c.toggleOrderedList()) },
  {
    group: "Basic", id: "toggle", icon: "chevrons-down-up", title: "Toggle", desc: "Hide details inside", md: ">>",
    run: (e, r) => {
      insertBlock(e, r, { type: "toggle", attrs: { open: true }, content: [{ type: "toggleSummary" }, { type: "toggleContent", content: [{ type: "paragraph" }] }] });
      // insertContent leaves the cursor in the body; start typing in the summary instead.
      const $f = e.state.selection.$from;
      for (let d = $f.depth; d > 0; d--)
        if ($f.node(d).type.name === "toggle") {
          e.commands.setTextSelection($f.before(d) + 2);
          break;
        }
    },
  },
  { group: "Basic", id: "quote", icon: "text-quote", title: "Quote", desc: "Pull a quote", md: ">", run: (e, r) => setBlock(e, r, (c) => c.setParagraph().toggleBlockquote()) },
  { group: "Basic", id: "callout", icon: "info", title: "Callout", desc: "Make it stand out", run: (e, r) => setBlock(e, r, (c) => c.setParagraph().wrapIn("callout", { tone: "blue", icon: "lightbulb" })) },
  { group: "Basic", id: "divider", icon: "minus", title: "Divider", desc: "Separate sections", md: "---", keywords: "hr rule", run: (e, r) => setBlock(e, r, (c) => c.setHorizontalRule()) },
  {
    group: "Data", id: "db", icon: "database", title: "Database", desc: "Table, board, calendar, gallery", keywords: "table kanban",
    run: (e, r) => insertLater(e, r, async () => [{ type: "database", attrs: { dbId: (await loadDatabase()).createDatabase(bridge.doc, "blank") } }, { type: "paragraph" }]),
  },
  {
    group: "Data", id: "csv", icon: "file-spreadsheet", title: "Import CSV", desc: "Turn a CSV into a database", keywords: "spreadsheet",
    run: (e, r) => {
      if (r) e.chain().focus().deleteRange(r).run();
      bridge.importCsv((csv) => insertLater(e, null, async () => [{ type: "database", attrs: { dbId: (await loadDatabase()).importCsvToDatabase(bridge.doc, csv) } }, { type: "paragraph" }]));
    },
  },
  { group: "Data", id: "table", icon: "table", title: "Simple table", desc: "Rows and columns", run: (e, r) => {
      insertBlock(e, r, [tableJSON(3, 3), { type: "paragraph" }]);
      // Start typing in the first header cell, not on the line below the table.
      let at = -1;
      e.state.doc.nodesBetween(0, e.state.selection.from, (n, pos) => {
        if (n.type.name === "table" && pos + n.nodeSize <= e.state.selection.from) at = pos;
      });
      if (at >= 0) e.commands.setTextSelection(at + 4);
    },
  },
  {
    group: "Media", id: "image", icon: "image", title: "Image", desc: "Upload or paste", keywords: "photo picture",
    run: (e, r) => insertBlock(e, r, [{ type: "image", attrs: { src: "", alt: "", caption: "" } }, { type: "paragraph" }]),
  },
  {
    group: "Media", id: "file", icon: "paperclip", title: "File", desc: "Attach any file", keywords: "upload pdf attachment",
    run: (e, r) => {
      if (r) e.chain().focus().deleteRange(r).run();
      bridge.pickFile("*/*", (f) => insertUploads(e, [f], undefined, "file"));
    },
  },
  {
    group: "Media", id: "date", icon: "calendar", title: "Date", desc: "A date chip, like @today", keywords: "today tomorrow due deadline calendar",
    run: (e, r) => {
      const at = r ? r.from : e.state.selection.from;
      const ch = e.chain().focus();
      if (r) ch.deleteRange(r);
      ch.insertContent([{ type: "dateMention", attrs: { date: isoDate(new Date()) } }, { type: "text", text: " " }]).run();
      datePickStore.set(at);
    },
  },
  {
    group: "Media", id: "link", icon: "link-2", title: "Link preview", desc: "Card for a URL", keywords: "bookmark url",
    run: (e, r) => {
      if (r) e.chain().focus().deleteRange(r).run();
      bridge.promptUrl("bookmark", (url) => e.chain().focus().insertContent([bookmarkNode(url), { type: "paragraph" }]).run());
    },
  },
  {
    group: "Media", id: "embed", icon: "circle-play", title: "Embed", desc: "YouTube, Figma, Loom, Maps", keywords: "video vimeo iframe",
    run: (e, r) => {
      if (r) e.chain().focus().deleteRange(r).run();
      bridge.promptUrl("embed", (url) => {
        const info = resolveEmbed(url);
        e.chain().focus().insertContent([{ type: "embed", attrs: { provider: info?.provider ?? "", url, title: hostOf(url) } }, { type: "paragraph" }]).run();
      });
    },
  },
  { group: "Media", id: "code", icon: "code-xml", title: "Code", desc: "With syntax highlighting", md: "```", run: (e, r) => setBlock(e, r, (c) => c.setCodeBlock()) },
  {
    group: "Layout", id: "board", icon: "shapes", title: "Whiteboard", desc: "Sketch inside the canvas", keywords: "draw diagram",
    run: (e, r) => insertLater(e, r, async () => [{ type: "board", attrs: { boardId: (await loadBoard()).createBoard(bridge.doc, "blank") } }, { type: "paragraph" }]),
  },
  { group: "Layout", id: "cols", icon: "columns-2", title: "Two columns", desc: "Side by side", keywords: "layout split", run: (e, r) => insertBlock(e, r, columnsJSON(2)) },
  { group: "Layout", id: "cols3", icon: "columns-3", title: "Three columns", desc: "Three across", keywords: "layout split", run: (e, r) => insertBlock(e, r, columnsJSON(3)) },
];

/** `n` empty columns, caret in the first. */
export function columnsJSON(n: number): JSONContent {
  return { type: "columns", content: Array.from({ length: n }, () => ({ type: "column", content: [{ type: "paragraph" }] })) };
}

// Last, so it never displaces the block types people use most.
SLASH.push({
  group: "Basic", id: "assistant", icon: "sparkles", title: "Assistant", desc: "Ask the assistant to write or organise", keywords: "ai ask",
  run: (e, r) => {
    if (r) e.chain().focus().deleteRange(r).run();
    openAssistant();
  },
});

/**
 * Matches, best first: title starts with the query, a title word starts with it,
 * the title contains it, then description / keywords / markdown hint.
 * ("/table" must offer "Simple table" before "Database".)
 */
export function filterSlash(q: string): SlashItem[] {
  const s = q.toLowerCase().trim();
  // `/assistant` only when the assistant is on for this person (docs/24 §10.2).
  const all = aiStore.get().on ? SLASH : SLASH.filter((x) => x.id !== "assistant");
  if (!s) return all;
  const rank = (x: SlashItem) => {
    const t = x.title.toLowerCase();
    if (t.startsWith(s)) return 0;
    if (t.split(/\s+/).some((w) => w.startsWith(s))) return 1;
    if (t.includes(s)) return 2;
    if ((x.desc + " " + (x.keywords ?? "") + " " + (x.md ?? "")).toLowerCase().includes(s)) return 3;
    return -1;
  };
  return all.map((x, i) => ({ x, r: rank(x), i }))
    .filter((e) => e.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((e) => e.x);
}

// ---------- turn into ----------

export const TURN: [id: string, icon: string, label: string][] = [
  ["p", "type", "Text"],
  ["h1", "heading-1", "Heading 1"],
  ["h2", "heading-2", "Heading 2"],
  ["h3", "heading-3", "Heading 3"],
  ["todo", "list-todo", "Checklist"],
  ["bul", "list", "Bulleted list"],
  ["num", "list-ordered", "Numbered list"],
  ["quote", "text-quote", "Quote"],
  ["callout", "info", "Callout"],
];

/** Which TURN id describes a top-level block node. */
export function kindOfNode(node: { type: { name: string }; attrs: Record<string, unknown> }): string {
  switch (node.type.name) {
    case "taskList":
      return "todo";
    case "bulletList":
      return "bul";
    case "orderedList":
      return "num";
    case "blockquote":
      return "quote";
    case "callout":
      return "callout";
    case "heading":
      return "h" + String(node.attrs.level ?? 1);
    default:
      return "p";
  }
}

/** Which TURN id describes the block at the selection. */
export function currentKind(editor: Editor): string {
  if (editor.isActive("taskList")) return "todo";
  if (editor.isActive("bulletList")) return "bul";
  if (editor.isActive("orderedList")) return "num";
  if (editor.isActive("blockquote")) return "quote";
  if (editor.isActive("callout")) return "callout";
  for (const l of [1, 2, 3]) if (editor.isActive("heading", { level: l })) return "h" + l;
  return "p";
}

export function turnInto(editor: Editor, kind: string) {
  // Normalise to a plain paragraph first, then apply the target.
  let c = editor.chain().focus();
  const cur = currentKind(editor);
  if (cur === kind) return;
  if (cur === "todo") c = c.toggleTaskList();
  else if (cur === "bul") c = c.toggleBulletList();
  else if (cur === "num") c = c.toggleOrderedList();
  else if (cur === "quote") c = c.lift("blockquote");
  else if (cur === "callout") c = c.lift("callout");
  c = c.setParagraph();
  switch (kind) {
    case "h1":
    case "h2":
    case "h3":
      c = c.setHeading({ level: Number(kind[1]) as 1 | 2 | 3 });
      break;
    case "todo":
      c = c.toggleTaskList();
      break;
    case "bul":
      c = c.toggleBulletList();
      break;
    case "num":
      c = c.toggleOrderedList();
      break;
    case "quote":
      c = c.toggleBlockquote();
      break;
    case "callout":
      c = c.wrapIn("callout", { tone: "blue", icon: "lightbulb" });
      break;
  }
  c.run();
}
