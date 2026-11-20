// @opencanvas/board: collaborative whiteboard block backed by Yjs.
// Y.Doc layout: docs/15-BUILD-CONTRACT.md §4 (`boards` root): shapes Y.Map<shapeId, Y.Map>, order Y.Array<shapeId>.
export { BoardBlock } from "./BoardBlock";
export { createBoard, readShapes, getBoardMap, BOARD_PRESETS, BOARD_ORIGIN } from "./model";
export type { BoardPreset, Shape, ShapeType } from "./model";
