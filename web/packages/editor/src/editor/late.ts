// Editor behaviour that is not needed to show a document, loaded right after
// first paint (docs/02 §7 budget): autolink + link-on-paste (linkifyjs), the
// slash / @mention suggestion plugins (@tiptap/suggestion, @floating-ui), and
// the drop and gap cursors (StarterKit options: 3 px drop cursor).
// The schema is complete from the start (`link.ts`), so this only adds
// ProseMirror plugins to the live editor; the Y.Doc never sees a new type.
import { getExtensionField, pasteRulesPlugin, type Editor, type PasteRule } from "@tiptap/core";
import { Link } from "@tiptap/extension-link";
import { dropCursor } from "@tiptap/pm/dropcursor";
import { gapCursor } from "@tiptap/pm/gapcursor";
import { PluginKey, type Plugin } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { LINK_OPTIONS } from "./link";
import { filterSlash, type SlashItem } from "./slash";
import { suggestRender } from "./suggest";

export interface MentionItem {
  id: string;
  label: string;
  color: string;
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
  return Suggestion<SlashItem, SlashItem>({
    editor,
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
  });
}

/** Same behaviour as @tiptap/extension-mention's default suggestion. */
function mentionPlugin(editor: Editor, search: (q: string) => Promise<MentionItem[]>): Plugin {
  return Suggestion<MentionItem, MentionItem>({
    editor,
    pluginKey: new PluginKey("mention"),
    char: "@",
    items: ({ query }) => search(query),
    command: ({ editor, range, props }) => {
      const after = editor.view.state.selection.$to.nodeAfter;
      if (after?.text?.startsWith(" ")) range.to += 1;
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: "mention", attrs: { ...props, mentionSuggestionChar: "@" } },
          { type: "text", text: " " },
        ])
        .run();
      editor.view.dom.ownerDocument.defaultView?.getSelection()?.collapseToEnd();
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

export function installLate(editor: Editor, search: (q: string) => Promise<MentionItem[]>) {
  if (editor.isDestroyed || installed.has(editor)) return;
  installed.add(editor);
  // Suggestion plugins go first, as their extensions' priority put them before: their
  // keydown (Enter / arrows in an open menu) must win over the base keymap.
  for (const p of [mentionPlugin(editor, search), slashPlugin(editor)]) editor.registerPlugin(p, (pl, all) => [pl, ...all]);
  for (const p of linkPlugins(editor)) editor.registerPlugin(p);
  editor.registerPlugin(dropCursor({ color: "currentColor", width: 3, class: "ProseMirror-dropcursor" }));
  editor.registerPlugin(gapCursor());
}
