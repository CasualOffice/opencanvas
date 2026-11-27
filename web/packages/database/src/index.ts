// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @opencanvas/database: collaborative database block (table, board, calendar, gallery) backed by Yjs.
// Y.Doc layout: docs/15-BUILD-CONTRACT.md §4 (`databases` root).
export { DatabaseBlock } from "./DatabaseBlock";
export { CsvImportDialog } from "./CsvImportDialog";
export type { CsvImportDialogProps } from "./CsvImportDialog";
export { createDatabase, importCsvToDatabase, databaseToCsv, readDb, getDbMap, DB_ORIGIN, moveRow, presetPeopleMap, addRow, deleteRow, cellToText, setCell } from "./model";
export { parseCsv, detectType, detectFields, coerce } from "./csv";
export { COMPUTED_TYPES } from "./types";
export type { DbPreset } from "./presets";
export { DB_PRESETS } from "./presets";
export type { DbField, DbOption, DbRow, DbSnapshot, FieldType, ViewKind, ViewPrefs, CellValue } from "./types";
