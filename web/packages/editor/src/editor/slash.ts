// Slash menu items (grouped, with tiles and markdown shortcuts) and block actions.
import { Extension, type Editor, type JSONContent, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { insertUploads } from "../lib/uploads";
import { tableJSON } from "./table";
import { loadBoard, loadDatabase } from "./blockdata";
import { bridge } from "../lib/bridge";
import { hostOf, resolveEmbed } from "../lib/embeds";
import { suggestRender } from "./suggest";

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
  { group: "Data", id: "table", icon: "table", title: "Simple table", desc: "Rows and columns", run: (e, r) => insertBlock(e, r, [tableJSON(3, 3), { type: "paragraph" }]) },
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
  {
    group: "Layout", id: "cols", icon: "columns-2", title: "Two columns", desc: "Side by side",
    run: (e, r) =>
      insertBlock(e, r, {
        type: "columns",
        content: [
          { type: "column", content: [{ type: "paragraph" }] },
          { type: "column", content: [{ type: "paragraph" }] },
        ],
      }),
  },
];

export function bookmarkNode(url: string): JSONContent {
  const site = hostOf(url);
  return { type: "bookmark", attrs: { url, title: site, description: "", site } };
}

export function filterSlash(q: string): SlashItem[] {
  const s = q.toLowerCase().trim();
  if (!s) return SLASH;
  return SLASH.filter((x) => (x.title + " " + x.desc + " " + (x.keywords ?? "") + " " + (x.md ?? "")).toLowerCase().includes(s));
}

export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slash"),
        char: "/",
        allowSpaces: false,
        allow: ({ state, range }) => {
          const $f = state.doc.resolve(range.from);
          return $f.parent.type.name === "paragraph" && !$f.node(1)?.type.spec.code;
        },
        items: ({ query }) => filterSlash(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: suggestRender("slash"),
      }),
    ];
  },
});

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
