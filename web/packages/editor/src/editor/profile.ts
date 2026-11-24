// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Editor profiles (EDP-01, ADR-061, docs/05 §2b, docs/15 §2 `editor`). The host's profile picks
// which block types the INSERTION surfaces offer: the / menu (and the gutter and phone "+", which
// open it), the phone bar's quick buttons, "Turn into", the empty-canvas starters and the
// markdown shortcuts that create a block. Every surface asks `insertable` / `blockAllowed` here.
//
// Hide, never delete: nothing here touches the schema, rendering, paste or stored content. A
// document full of hidden types opens, renders, stays editable and round-trips unchanged.
import { createStore } from "../lib/store";

/** The session's `editor` (docs/15 §2). */
export interface EditorProfile {
  profile: string;
  allowProfileSwitch?: boolean;
  /** Insertable block ids (`core.*` and SDK types). */
  blocks: string[];
  quickInsert?: string[];
  features?: Partial<Record<"comments" | "versionHistory" | "ai" | "diagramming" | "templates" | "import", boolean>>;
}

/** `null`: no profile from the server (older server, demo): everything, as before. */
export const profileStore = createStore<EditorProfile | null>(null);

export function setEditorProfile(p: EditorProfile | null | undefined): void {
  profileStore.set(p && Array.isArray(p.blocks) ? p : null);
}

/** Stable core block ids (mirrors `oc_server::editor::CORE_BLOCKS`; a test keeps them equal). */
export const CORE_BLOCKS = [
  "core.text", "core.heading", "core.checklist", "core.bulleted_list", "core.numbered_list", "core.toggle", "core.quote",
  "core.callout", "core.divider", "core.code", "core.database", "core.kanban", "core.calendar", "core.table", "core.image",
  "core.file", "core.date", "core.link_preview", "core.embed", "core.whiteboard", "core.diagram", "core.shapes",
  "core.columns", "core.import", "core.assistant",
] as const;
export type CoreBlock = (typeof CORE_BLOCKS)[number];

/**
 * Which core ids each / menu entry inserts: the entry shows when ANY of them is enabled
 * (Database also serves its kanban and calendar views; Whiteboard its diagram and shapes modes).
 */
export const SLASH_BLOCKS: Record<string, CoreBlock[]> = {
  p: ["core.text"],
  h1: ["core.heading"],
  h2: ["core.heading"],
  h3: ["core.heading"],
  todo: ["core.checklist"],
  bul: ["core.bulleted_list"],
  num: ["core.numbered_list"],
  toggle: ["core.toggle"],
  quote: ["core.quote"],
  callout: ["core.callout"],
  divider: ["core.divider"],
  db: ["core.database", "core.kanban", "core.calendar"],
  csv: ["core.database", "core.kanban", "core.calendar"],
  table: ["core.table"],
  image: ["core.image"],
  file: ["core.file"],
  date: ["core.date"],
  link: ["core.link_preview"],
  embed: ["core.embed"],
  code: ["core.code"],
  board: ["core.whiteboard", "core.diagram", "core.shapes"],
  cols: ["core.columns"],
  cols3: ["core.columns"],
  import: ["core.import"],
  assistant: ["core.assistant"],
};

/** Intent keywords (keyword match only, no AI): what people say they want to do. */
export const INTENT: Record<CoreBlock, string> = {
  "core.text": "write notes paragraph plain writing jot",
  "core.heading": "title section agenda heading outline",
  "core.checklist": "track tasks todo action items to-do follow up assign",
  "core.bulleted_list": "list points notes bullets",
  "core.numbered_list": "steps ordered sequence procedure agenda",
  "core.toggle": "collapse details hide expand faq",
  "core.quote": "cite quotation testimonial",
  "core.callout": "note warning tip highlight important decision",
  "core.divider": "separate break line section",
  "core.code": "snippet program script syntax",
  "core.database": "track tasks plan sprint project tracker records roadmap backlog",
  "core.kanban": "board kanban plan sprint workflow status columns",
  "core.calendar": "schedule calendar events dates timeline plan",
  "core.table": "grid rows columns compare matrix",
  "core.image": "photo picture screenshot illustration",
  "core.file": "attach upload document pdf",
  "core.date": "due deadline when schedule",
  "core.link_preview": "link website url bookmark reference",
  "core.embed": "video youtube figma loom map",
  "core.whiteboard": "draw sketch architecture brainstorm whiteboard canvas",
  "core.diagram": "draw architecture diagram flowchart flow chart",
  "core.shapes": "shapes boxes arrows draw",
  "core.columns": "side by side layout split",
  "core.import": "import upload markdown html csv",
  "core.assistant": "ai ask help write",
};

/** The intent keywords of a / menu entry (all its core ids). */
export function intentOf(slashId: string): string {
  return (SLASH_BLOCKS[slashId] ?? []).map((b) => INTENT[b]).join(" ");
}

/** Whether insertion surfaces may offer this block id. No profile: everything. */
export function blockAllowed(id: string, p: EditorProfile | null = profileStore.get()): boolean {
  if (id === "core.text") return true;
  return !p || p.blocks.includes(id);
}

/**
 * THE shared filter of every insertion surface: a / menu entry (by its id) or an SDK block
 * package (by `type`, and its manifest `discovery.profiles`, read defensively).
 */
export function insertable(item: { id?: string; type?: string; discovery?: unknown }, p: EditorProfile | null = profileStore.get()): boolean {
  if (!p) return true;
  if (item.type && !item.id) {
    if (p.blocks.includes(item.type)) return true;
    // An explicit block list names SDK types itself; otherwise the manifest says which profiles.
    if (p.blocks.some((b) => !b.startsWith("core."))) return false;
    const profiles = (item.discovery as { profiles?: unknown } | undefined)?.profiles;
    if (!Array.isArray(profiles)) return true;
    return p.profile === "full" || profiles.includes(p.profile);
  }
  const ids = SLASH_BLOCKS[item.id ?? ""];
  if (!ids) return true;
  return ids.some((b) => blockAllowed(b, p));
}

/** Which node types' markdown shortcuts (input rules) create which block. */
const RULE_BLOCKS: Record<string, CoreBlock> = {
  heading: "core.heading",
  bulletList: "core.bulleted_list",
  orderedList: "core.numbered_list",
  taskList: "core.checklist",
  taskItem: "core.checklist",
  blockquote: "core.quote",
  horizontalRule: "core.divider",
  codeBlock: "core.code",
  toggle: "core.toggle",
};

/**
 * Tiptap's `enableInputRules`: `true` (all) without a profile, else every extension except the
 * ones whose shortcut would create a hidden block. Marks (bold, …) keep theirs.
 */
export function inputRuleExtensions(names: string[], p: EditorProfile | null = profileStore.get()): true | string[] {
  if (!p) return true;
  return names.filter((n) => !RULE_BLOCKS[n] || blockAllowed(RULE_BLOCKS[n], p));
}

/** `useEditor` options: the extensions and the input rules this profile allows. */
export function withInputRules<E extends { name: string }>(extensions: E[]): { extensions: E[]; enableInputRules: true | string[] } {
  return { extensions, enableInputRules: inputRuleExtensions(extensions.map((e) => e.name)) };
}

/** A feature switch from the session; absent means on (today's behaviour). */
export function featureOn(f: keyof NonNullable<EditorProfile["features"]>, p: EditorProfile | null = profileStore.get()): boolean {
  return p?.features?.[f] !== false;
}
