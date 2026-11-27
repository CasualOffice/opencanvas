// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @opencanvas/sheet: the Spreadsheet block (ADR-080). Loaded lazily by the editor; nothing here
// is in the initial bundle.

export { loadSheetEngine, setEngineSource, EngineError, type EngineSheet, type SheetEngine, type Shown } from "./engine/engine";
export { createSheetBlock } from "./model";
export { SheetBlock, SHEET_ORIGIN, type AwarenessLike } from "./SheetBlock";
