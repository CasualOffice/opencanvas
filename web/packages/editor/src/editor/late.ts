// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Editor behaviour that is not needed to show a document, loaded right after
// first paint (docs/02 §7 budget): autolink + link-on-paste (linkifyjs), the
// slash / @mention suggestion plugins (@tiptap/suggestion, @floating-ui), and
// the drop and gap cursors (StarterKit options: 3 px drop cursor).
// The schema is complete from the start (`link.ts`), so this only adds
// ProseMirror plugins to the live editor; the Y.Doc never sees a new type.
import { addDays, datePickStore, isoDate } from "./inline";
import { ensureBlockIdAt } from "./blockId";
import { getExtensionField, pasteRulesPlugin, type Editor, type PasteRule } from "@tiptap/core";
import { Link } from "@tiptap/extension-link";
import { dropCursor } from "@tiptap/pm/dropcursor";
import { gapCursor } from "@tiptap/pm/gapcursor";
import { PluginKey, type Plugin } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { LINK_OPTIONS } from "./link";
import { suggestRender } from "./suggest";
import type { Editor as CoreEditor, Range } from "@tiptap/core";
import { insertCtx, insertKey } from "./insert/controller";
import { nothingToInsert } from "./insert/model";

/** What the insert menu hands the "/" plugin: anything that inserts at the typed range. */
interface InsertRun {
  run(editor: CoreEditor, range: Range): void;
}

export interface MentionItem {
  id: string;
  label: string;
  color: string;
  /** docs/21: avatar, initials (with a collision subscript), the second line, a relation note,
   *  whether the name is shared, and an access warning ("Ravi can't open this canvas"). */
  avatar?: string;
  initials?: string;
  second?: string;
  note?: string;
  dup?: boolean;
  warn?: string;
  /** A date chip (`@today`, `@tomorrow`) instead of a person; `pick` opens the date picker. */
  date?: string;
  pick?: boolean;
}

const prefixOf = (q: string, word: string) => q.length > 0 && word.startsWith(q);

/** Date entries for the @ menu: today, tomorrow and "Pick a date…", filtered by the query. */
export function dateItems(query: string, now = new Date()): MentionItem[] {
  const q = query.trim().toLowerCase();
  const out: MentionItem[] = [];
  if (!q || prefixOf(q, "today")) out.push({ id: "date:today", label: "Today", color: "", date: isoDate(now) });
  if (!q || prefixOf(q, "tomorrow")) out.push({ id: "date:tomorrow", label: "Tomorrow", color: "", date: isoDate(addDays(now, 1)) });
  if (!q || prefixOf(q, "date") || prefixOf(q, "pick")) out.push({ id: "date:pick", label: "Pick a date…", color: "", date: isoDate(now), pick: true });
  return out;
}

function linkPlugins(editor: Editor): Plugin[] {
  const type = editor.schema.marks.link;
  if (!type) return [];
  const ext = Link.configure(LINK_OPTIONS);
  const ctx = { name: "link", options: ext.options, storage: {}, editor, type, parent: undefined };
  const pm = getExtensionField<(() => Plugin[]) | undefined>(ext, "addProseMirrorPlugins", ctx)?.() ?? [];
  // The click handler does nothing with openOnClick off; the schema mark already exists.
  const plugins = pm.filter((p) => !(p as unknown as { key: string }).key.startsWith("handleClickLink$"));
  const rules = getExtensionField<(() => PasteRule[]) | undefined>(ext, "addPasteRules", ctx)?.() ?? [];
  if (rules.length) plugins.push(...pasteRulesPlugin({ editor, rules }));
  return plugins;
}

function slashPlugin(editor: Editor): Plugin {
  // INS-01: the insert menu (insert/) draws its own bands and results from the query; goal
  // phrases have spaces ("/track tasks"). With only Text to insert there is no menu (5d).
  return Suggestion<InsertRun, InsertRun>({
    editor,
    pluginKey: new PluginKey("slash"),
    char: "/",
    allowSpaces: true,
    allow: ({ state, range }) => {
      const $f = state.doc.resolve(range.from);
      return $f.parent.type.name === "paragraph" && !$f.node(1)?.type.spec.code && !nothingToInsert(insertCtx(editor));
    },
    items: () => [],
    command: ({ editor, range, props }) => props.run(editor, range),
    render: suggestRender("slash", insertKey),
  });
}

/** Same behaviour as @tiptap/extension-mention's default suggestion. */
function mentionPlugin(editor: Editor, search: (q: string) => Promise<MentionItem[]>): Plugin {
  return Suggestion<MentionItem, MentionItem>({
    editor,
    pluginKey: new PluginKey("mention"),
    char: "@",
    // People first (the host's list), then dates; a date word ("tod", "tomorrow") puts dates first.
    items: async ({ query }) => {
      const dates = editor.schema.nodes.dateMention ? dateItems(query) : [];
      const people = await search(query);
      return /^(to|da|pi)/i.test(query) ? [...dates, ...people] : [...people, ...dates];
    },
    command: ({ editor, range, props }) => {
      const after = editor.view.state.selection.$to.nodeAfter;
      if (after?.text?.startsWith(" ")) range.to += 1;
      const at = range.from;
      const node = props.date ? { type: "dateMention", attrs: { date: props.date } } : { type: "mention", attrs: { id: props.id, label: props.label, mentionSuggestionChar: "@" } };
      editor
        .chain()
        .focus()
        .insertContentAt(range, [node, { type: "text", text: " " }])
        .run();
      editor.view.dom.ownerDocument.defaultView?.getSelection()?.collapseToEnd();
      // A person mention makes the block linkable: the host's notification carries its id.
      if (!props.date) ensureBlockIdAt(editor, Math.min(at, editor.state.doc.content.size));
      else if (props.pick) datePickStore.set(at);
    },
    allow: ({ state, range }) => {
      const $from = state.doc.resolve(range.from);
      const type = state.schema.nodes.mention;
      return !!type && !!$from.parent.type.contentMatch.matchType(type);
    },
    render: suggestRender("mention"),
  });
}

const installed = new WeakSet<Editor>();

/** `nested`: a live block's own editor gets the "/" menu (filtered, see `insertCtx`) and the
 *  cursors; no @mentions (the people and notifications are the embedding canvas's). */
export function installLate(editor: Editor, search: (q: string) => Promise<MentionItem[]>, nested = false) {
  if (editor.isDestroyed || installed.has(editor)) return;
  installed.add(editor);
  if (nested) {
    editor.registerPlugin(slashPlugin(editor), (pl, all) => [pl, ...all]);
    editor.registerPlugin(dropCursor({ color: "currentColor", width: 3, class: "ProseMirror-dropcursor" }));
    editor.registerPlugin(gapCursor());
    return;
  }
  // Suggestion plugins go first, as their extensions' priority put them before: their
  // keydown (Enter / arrows in an open menu) must win over the base keymap.
  for (const p of [mentionPlugin(editor, search), slashPlugin(editor)]) editor.registerPlugin(p, (pl, all) => [pl, ...all]);
  for (const p of linkPlugins(editor)) editor.registerPlugin(p);
  editor.registerPlugin(dropCursor({ color: "currentColor", width: 3, class: "ProseMirror-dropcursor" }));
  editor.registerPlugin(gapCursor());
}
