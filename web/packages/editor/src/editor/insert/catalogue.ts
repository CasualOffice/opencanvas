// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The insert menu's catalogue (INS-01, docs/prototypes/insert-menu-approved): built-in blocks in
// five categories, the six that carry variants, and every block's and variant's names (aliases),
// intent phrases and "why" line. Data only: no editor, no DOM. What each entry inserts is
// `run.ts`; which entries a profile offers is `profile.ts` (`needs` are core block ids).

export type CatId = "content" | "data" | "visual" | "layout" | "ext";

export interface Cat {
  id: CatId;
  icon: string;
  title: string;
  tone: "blue" | "green" | "purple" | "amber" | "gray";
  desc: string;
  /** The block SDK's `discovery.category` that files an SDK block here. */
  disc: string;
}

export const CATS: Cat[] = [
  { id: "content", icon: "pilcrow", title: "Content", tone: "blue", desc: "Text, headings, lists", disc: "content" },
  { id: "data", icon: "kanban", title: "Data & planning", tone: "green", desc: "Databases, dates", disc: "data-planning" },
  { id: "visual", icon: "shapes", title: "Visual & diagrams", tone: "purple", desc: "Diagrams, images", disc: "visual" },
  { id: "layout", icon: "columns-2", title: "Layout", tone: "amber", desc: "Columns, toggles", disc: "layout" },
  { id: "ext", icon: "puzzle", title: "Extensions", tone: "gray", desc: "From your organisation", disc: "extensions" },
];

/** The Extensions heading in menus (approved SDK decision 6). */
export const ORG_HEAD = "From your organisation";

export interface Variant {
  id: string;
  /** Full name: "Heading 2", "Checklist", "Board view". */
  label: string;
  /** Short name for a step row and its cards: "Board", "UML". */
  short?: string;
  /** Segment text for text segments ("H2"); icon segments use `icon`. */
  seg?: string;
  icon: string;
  md?: string;
  /** Callout tone swatch. */
  tone?: string;
  names: string[];
  intents: string[];
  why: string;
  /** Core block ids; offered when any is enabled. */
  needs: string[];
}

export interface BlockDef {
  key: string;
  icon: string;
  title: string;
  desc: string;
  cat: CatId;
  /** `seg`: inline segmented choice (desktop); `step`: a second step with previews. */
  mode?: "seg" | "step";
  /** What Tab changes, for the key hint and screen readers ("level", "type", "style", "layout", "view"). */
  segLabel?: string;
  def?: string;
  variants?: Variant[];
  md?: string;
  names: string[];
  intents: string[];
  why: string;
  needs: string[];
  /** Import and the assistant: actions, not blocks (no tile, not counted for the flat list). */
  action?: "import" | "assistant" | "live";
}

const v = (id: string, label: string, icon: string, needs: string[], names: string[], intents: string[], why: string, more: Partial<Variant> = {}): Variant => ({
  id, label, icon, needs, names, intents, why, ...more,
});

export const BLOCKS: BlockDef[] = [
  // ---------- Content ----------
  { key: "text", icon: "type", title: "Text", desc: "Just start writing", cat: "content", needs: ["core.text"], names: ["p", "paragraph", "plain text"], intents: ["write notes", "jot down", "plain writing"], why: "plain paragraphs" },
  {
    key: "heading", icon: "heading", title: "Heading", desc: "Section title", cat: "content", mode: "seg", segLabel: "level", def: "2", needs: ["core.heading"], names: ["title", "section"], intents: ["section title", "outline", "agenda"], why: "a section title",
    variants: [
      v("1", "Heading 1", "heading-1", ["core.heading"], ["h1", "heading 1", "#"], ["page title"], "a big title", { seg: "H1", md: "#" }),
      v("2", "Heading 2", "heading-2", ["core.heading"], ["h2", "heading 2", "##", "subheading"], ["section title", "agenda"], "a section title", { seg: "H2", md: "##" }),
      v("3", "Heading 3", "heading-3", ["core.heading"], ["h3", "heading 3", "###"], ["subsection"], "a small title", { seg: "H3", md: "###" }),
    ],
  },
  {
    key: "list", icon: "list", title: "List", desc: "Bullets, steps or tasks", cat: "content", mode: "seg", segLabel: "type", def: "bulleted", needs: ["core.bulleted_list", "core.numbered_list", "core.checklist"], names: [], intents: [], why: "a list",
    variants: [
      v("bulleted", "Bulleted list", "list", ["core.bulleted_list"], ["bul", "bullet", "bulleted", "ul", "-", "bulleted list", "unordered list"], ["write notes", "key points", "brainstorm ideas"], "quick points", { md: "-" }),
      v("numbered", "Numbered list", "list-ordered", ["core.numbered_list"], ["num", "numbered", "ol", "steps", "1.", "numbered list", "ordered list"], ["write steps", "procedure", "how to"], "steps in order", { md: "1." }),
      v("checklist", "Checklist", "list-todo", ["core.checklist"], ["todo", "to-do", "checklist", "check", "task", "checkbox", "[]"], ["track tasks", "action items", "follow up", "sprint goals", "to-do list"], "tick tasks off as you go", { md: "[]" }),
    ],
  },
  { key: "quote", icon: "text-quote", title: "Quote", desc: "Pull a quote", cat: "content", md: ">", needs: ["core.quote"], names: ["blockquote", "cite", ">"], intents: ["quote someone", "testimonial", "write notes"], why: "someone's words, set apart" },
  {
    key: "callout", icon: "info", title: "Callout", desc: "Make it stand out", cat: "content", mode: "seg", segLabel: "style", def: "info", needs: ["core.callout"], names: [], intents: [], why: "make it stand out",
    variants: [
      v("info", "Info", "info", ["core.callout"], ["info", "note", "callout"], ["highlight", "important note"], "an important note", { tone: "blue" }),
      v("tip", "Tip", "lightbulb", ["core.callout"], ["tip", "hint"], ["share a tip", "best practice"], "a helpful tip", { tone: "green" }),
      v("warning", "Warning", "triangle-alert", ["core.callout"], ["warning", "warn", "caution", "risk"], ["flag a risk", "warn readers"], "a risk or caution", { tone: "amber" }),
      v("decision", "Decision", "circle-check", ["core.callout"], ["decision", "decided", "outcome"], ["record decisions", "meeting decisions"], "what was decided", { tone: "purple" }),
    ],
  },
  { key: "code", icon: "code-xml", title: "Code", desc: "With syntax highlighting", cat: "content", md: "```", needs: ["core.code"], names: ["```", "snippet", "code block"], intents: ["share code", "script", "program"], why: "code with highlighting" },
  { key: "link", icon: "link-2", title: "Link preview", desc: "A card for a URL", cat: "content", needs: ["core.link_preview"], names: ["link", "bookmark", "url"], intents: ["share a link", "reference a website"], why: "a card for a web page" },
  { key: "file", icon: "paperclip", title: "File", desc: "Attach any file", cat: "content", needs: ["core.file"], names: ["attachment", "attach", "upload", "pdf"], intents: ["attach a document", "share a file"], why: "any file, attached" },
  // ---------- Data & planning ----------
  {
    key: "database", icon: "database", title: "Database", desc: "Table, board, calendar or gallery", cat: "data", mode: "step", segLabel: "view", def: "table", needs: ["core.database", "core.kanban", "core.calendar"], names: ["db"], intents: [], why: "records with properties",
    variants: [
      v("table", "Table view", "table", ["core.database"], ["table view", "grid"], ["track tasks", "records", "tracker", "project tracker"], "tasks with due dates and fields", { short: "Table" }),
      v("board", "Board view", "kanban", ["core.kanban", "core.database"], ["board", "kanban", "board view"], ["track tasks", "plan sprint", "backlog", "status", "pipeline", "roadmap", "workflow"], "tasks by status, with owners", { short: "Board" }),
      v("calendar", "Calendar view", "calendar-days", ["core.calendar", "core.database"], ["calendar", "calendar view"], ["plan dates", "schedule", "events", "release plan", "timeline"], "plan dates and releases", { short: "Calendar" }),
      v("gallery", "Gallery view", "layout-grid", ["core.database"], ["gallery", "cards", "gallery view"], ["reading list", "collection", "moodboard"], "cards with a cover", { short: "Gallery" }),
    ],
  },
  { key: "spreadsheet", icon: "sheet", title: "Spreadsheet", desc: "Cells, formulas and sheets, like Excel", cat: "data", needs: ["core.spreadsheet"], names: ["sheet", "excel", "spreadsheet", "calc", "formulas"], intents: ["budget", "calculate", "numbers"], why: "cells and formulas, like Excel" },
  { key: "table", icon: "table", title: "Simple table", desc: "Rows and columns", cat: "data", needs: ["core.table"], names: ["table", "grid", "rows"], intents: ["compare options", "matrix", "rows and columns"], why: "rows and columns" },
  { key: "date", icon: "calendar", title: "Date", desc: "A date chip, like @today", cat: "data", needs: ["core.date"], names: ["today", "tomorrow", "due", "deadline"], intents: ["due date", "track tasks", "deadline", "schedule"], why: "a due date in a line of text" },
  { key: "csv", icon: "file-spreadsheet", title: "Import CSV", desc: "Turn a CSV into a database", cat: "data", needs: ["core.database", "core.kanban", "core.calendar"], names: ["csv", "spreadsheet"], intents: ["import data"], why: "a database from a CSV" },
  // LIVE-03 (1e): the host's own picker (`UI_PickLiveBlock`); offered only with `perms.live`.
  { key: "live", icon: "radio", title: "Live block", desc: "Pick one from your app; edits show everywhere", cat: "data", action: "live", needs: [], names: ["live", "live block", "synced block", "sync", "reuse"], intents: ["reuse a block", "show it in many places"], why: "one block, kept the same everywhere" },
  { key: "import", icon: "upload", title: "Import…", desc: "Markdown, HTML or CSV into this canvas", cat: "data", action: "import", needs: ["core.import"], names: ["import", "markdown", "html"], intents: ["import a file"], why: "bring in another document" },
  // ---------- Visual & diagrams ----------
  {
    key: "diagram", icon: "workflow", title: "Diagram", desc: "Flowchart, UML, ERD, network…", cat: "visual", mode: "step", segLabel: "type", def: "flowchart", needs: ["core.diagram"], names: ["diagram"], intents: [], why: "shapes and connectors",
    variants: [
      v("flowchart", "Flowchart", "workflow", ["core.diagram"], ["flow", "flowchart", "flow chart"], ["map a process", "workflow", "decision tree"], "steps and decisions", { short: "Flowchart" }),
      v("uml", "UML class", "boxes", ["core.diagram"], ["uml", "class diagram"], ["draw architecture", "model classes", "system design"], "components and their relations", { short: "UML" }),
      v("erd", "Entity relationship", "table", ["core.diagram"], ["erd", "entity relationship", "er diagram", "schema"], ["draw architecture", "model data", "database schema"], "tables and keys", { short: "ERD" }),
      v("network", "Network and cloud", "network", ["core.diagram"], ["network", "cloud", "infra", "infrastructure"], ["draw architecture", "system design", "deployment", "services"], "services, servers and links", { short: "Network" }),
      v("mindmap", "Mind map", "split", ["core.diagram"], ["mindmap", "mind map"], ["brainstorm ideas", "map ideas"], "ideas around a centre", { short: "Mind map" }),
      v("org", "Org chart", "users-round", ["core.diagram"], ["org", "org chart", "organisation chart", "organization chart"], ["team structure", "who reports to whom"], "people and teams", { short: "Org chart" }),
      v("wireframe", "Wireframe", "app-window", ["core.diagram"], ["wireframe", "mockup"], ["sketch a screen", "design a page"], "screens and controls", { short: "Wireframe" }),
      v("blank", "Blank diagram", "square-dashed", ["core.diagram"], ["blank diagram"], ["draw a diagram"], "every shape library", { short: "Blank" }),
    ],
  },
  { key: "board", icon: "shapes", title: "Whiteboard", desc: "Sketch freely on a board", cat: "visual", needs: ["core.whiteboard", "core.shapes"], names: ["whiteboard", "sketch", "draw", "canvas"], intents: ["draw architecture", "brainstorm ideas", "sketch", "draw freely"], why: "a rough sketch first" },
  { key: "image", icon: "image", title: "Image", desc: "Upload or paste", cat: "visual", needs: ["core.image"], names: ["photo", "picture", "img", "screenshot"], intents: ["add a picture", "screenshot"], why: "a picture or screenshot" },
  { key: "embed", icon: "circle-play", title: "Embed", desc: "YouTube, Figma, Loom, Maps", cat: "visual", needs: ["core.embed"], names: ["video", "youtube", "figma", "loom", "maps", "vimeo", "iframe"], intents: ["show a video", "embed a design"], why: "a live video, design or map" },
  // ---------- Layout ----------
  {
    key: "columns", icon: "columns-2", title: "Columns", desc: "Side by side", cat: "layout", mode: "seg", segLabel: "layout", def: "2", needs: ["core.columns"], names: ["layout", "split"], intents: [], why: "side by side",
    variants: [
      v("2", "2 columns", "columns-2", ["core.columns"], ["cols", "cols2", "2 columns", "two columns"], ["side by side", "compare options"], "two things side by side"),
      v("3", "3 columns", "columns-3", ["core.columns"], ["cols3", "3 columns", "three columns"], ["plan now next later", "plan roadmap"], "now, next, later"),
      v("4", "4 columns", "columns-4", ["core.columns"], ["cols4", "4 columns", "four columns"], ["four across"], "four across"),
      v("sidebar", "Sidebar and main", "panel-left", ["core.columns"], ["sidebar", "sidebar and main"], ["page layout"], "a narrow side and a main column"),
    ],
  },
  { key: "toggle", icon: "chevrons-down-up", title: "Toggle", desc: "Hide details inside", cat: "layout", md: ">>", needs: ["core.toggle"], names: [">>", "collapse", "details", "accordion", "faq"], intents: ["hide details", "faq"], why: "details behind a click" },
  { key: "divider", icon: "minus", title: "Divider", desc: "Separate sections", cat: "layout", md: "---", needs: ["core.divider"], names: ["hr", "rule", "---", "separator", "line"], intents: ["separate sections"], why: "a line between sections" },
  // ---------- action, never in a category ----------
  { key: "assistant", icon: "sparkles", title: "Assistant", desc: "Ask the assistant to write or organise", cat: "content", action: "assistant", needs: ["core.assistant"], names: ["ai", "ask"], intents: ["write for me", "summarise"], why: "the assistant writes it" },
];

export const blockByKey = (k: string): BlockDef | undefined => BLOCKS.find((b) => b.key === k);

/** Goal chips (3a): each fills the query with its phrase. A host replaces them with `chips`. */
export const DEFAULT_CHIPS = ["Track tasks", "Draw architecture", "Write notes"];

/** Quick insert when the host sets none (1a). */
export const DEFAULT_QUICK = ["text", "heading", "list", "image", "table"];

/** Defaults a profile changes (5a: the meeting variants are Checklist and Decision). */
export const PROFILE_DEFAULTS: Record<string, Record<string, string>> = {
  meeting: { list: "checklist", callout: "decision" },
  project: { list: "checklist", database: "board" },
};

/** The core block id (EDP-01 `quick_insert`) to a catalogue entry and variant. */
export const CORE_TO_ENTRY: Record<string, [string, string?]> = {
  "core.text": ["text"],
  "core.heading": ["heading"],
  "core.checklist": ["list", "checklist"],
  "core.bulleted_list": ["list", "bulleted"],
  "core.numbered_list": ["list", "numbered"],
  "core.toggle": ["toggle"],
  "core.quote": ["quote"],
  "core.callout": ["callout"],
  "core.divider": ["divider"],
  "core.code": ["code"],
  "core.database": ["database"],
  "core.kanban": ["database", "board"],
  "core.calendar": ["database", "calendar"],
  "core.table": ["table"],
  "core.spreadsheet": ["spreadsheet"],
  "core.image": ["image"],
  "core.file": ["file"],
  "core.date": ["date"],
  "core.link_preview": ["link"],
  "core.embed": ["embed"],
  "core.whiteboard": ["board"],
  "core.diagram": ["diagram"],
  "core.shapes": ["board"],
  "core.columns": ["columns"],
  "core.import": ["import"],
  "core.assistant": ["assistant"],
};

/** Words a query ignores ("plan a sprint" is "plan sprint"). */
export const STOP = new Set(["a", "an", "the", "to", "for", "of", "my", "our", "and", "in", "on", "with", "some", "i", "we", "want", "need", "let", "lets", "me", "make", "add", "new", "insert", "create"]);
