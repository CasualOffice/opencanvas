// Code-block syntax highlighting, loaded after first paint (docs/02 §7 budget).
//
// lowlight + the highlight.js "common" grammars are ~40 KB gzip, so they are
// not part of the initial JS. The `codeBlock` node (schema, attrs, node view)
// is defined up front by `OcCodeBlock`; once this module loads, the
// decoration plugin from Tiptap's CodeBlockLowlight is registered on the live
// editor, so the document is never re-created and collaborators see no flicker.
import { getExtensionField, type Editor } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import type { Plugin } from "@tiptap/pm/state";
import { common, createLowlight } from "lowlight";

export const lowlight = createLowlight(common);

/** The language highlight.js guesses for `text` (auto-detect), or null. */
export function detect(text: string): string | null {
  if (!text.trim()) return null;
  return lowlight.highlightAuto(text).data?.language ?? null;
}

/** Registers CodeBlockLowlight's decoration plugin on an editor that already has a `codeBlock` node. */
export function installHighlight(editor: Editor) {
  const ext = CodeBlockLowlight.configure({ lowlight, defaultLanguage: null });
  const type = editor.schema.nodes.codeBlock;
  if (!type || editor.isDestroyed) return;
  const add = getExtensionField<(() => Plugin[]) | undefined>(ext, "addProseMirrorPlugins", {
    name: "codeBlock",
    options: ext.options,
    storage: {},
    editor,
    type,
  });
  // Keep only the lowlight plugin: the CodeBlock plugins are already installed by OcCodeBlock.
  const plugins = (add?.() ?? []).filter((p) => (p as unknown as { key: string }).key.startsWith("lowlight$"));
  for (const p of plugins) editor.registerPlugin(p);
}
