import { Extension, type Editor } from "@tiptap/core";

/** Block node types that can carry a `blockId` (docs/15 §4). */
export const BLOCK_ID_TYPES = [
  "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem",
  "blockquote", "codeBlock", "horizontalRule", "image", "table", "callout", "toggle",
  "database", "board", "bookmark", "embed", "fileAttachment", "columns",
];

/**
 * Keeps the optional `blockId` attribute the host REST API addresses blocks by
 * (`POST /v1/files/:id/patch`). Without a schema attribute ProseMirror drops it on the
 * first local edit. Ids are never copied onto the second half of a split block, so a
 * split cannot create duplicates; the editor does not invent ids itself.
 */
export const BlockId = Extension.create({
  name: "blockId",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_ID_TYPES,
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-block-id"),
            renderHTML: (attrs) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
          },
        },
      },
    ];
  },
});

/** `b_` + 26 lowercase base32 characters (docs/15 §4). */
export function newBlockId(): string {
  const a = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  return "b_" + Array.from(bytes, (b) => a[b & 31]).join("");
}

/**
 * Gives the text block around `pos` a `blockId` when it has none, so the host can link to it
 * (mention notifications carry it, docs/05 §5). Returns the id.
 */
export function ensureBlockIdAt(editor: Editor, pos: number): string | null {
  const $p = editor.state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (!BLOCK_ID_TYPES.includes(n.type.name)) continue;
    if (n.attrs.blockId) return n.attrs.blockId as string;
    const id = newBlockId();
    editor.view.dispatch(editor.state.tr.setNodeMarkup($p.before(d), undefined, { ...n.attrs, blockId: id }).setMeta("addToHistory", false));
    return id;
  }
  return null;
}
