import { Extension } from "@tiptap/core";

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
