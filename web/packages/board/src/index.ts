// @opencanvas/board: collaborative whiteboard block backed by Yjs.
// Y.Doc layout: docs/15-BUILD-CONTRACT.md §4 (`boards` root): shapes Y.Map<shapeId, Y.Map>, order Y.Array<shapeId>.
export { BoardBlock } from "./BoardBlock";
export { createBoard, readShapes, getBoardMap, BOARD_PRESETS, BOARD_ORIGIN } from "./model";
export type { BoardPreset, Shape, ShapeType } from "./model";
export { exportBoardSvg, exportBoardPng } from "./export";
export { resolveArrow, syncBoundArrows, snapTarget, ANCHORS } from "./connectors";
export type { Anchor, Binding, ArrowRoute } from "./connectors";
export { MAX_INLINE_IMAGE } from "./images";
