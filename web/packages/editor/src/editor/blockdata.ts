// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The database and board packages are heavy (views, styles, presets), so they
// stay out of the initial bundle (docs/02 §7). Everything that needs them goes
// through these loaders; nothing in the entry graph may import them statically
// (type-only imports are fine).
import type * as Database from "@opencanvas/database";
import type * as Board from "@opencanvas/board";

let db: Promise<typeof Database> | null = null;
let board: Promise<typeof Board> | null = null;

// A failed load is forgotten so the next attempt fetches again (placeholder retry, ADR-076).
export const loadDatabase = () => (db ??= import("@opencanvas/database").catch((e) => ((db = null), Promise.reject(e))));
export const loadBoard = () => (board ??= import("@opencanvas/board").catch((e) => ((board = null), Promise.reject(e))));

export interface BlockData {
  createDatabase: typeof Database.createDatabase;
  importCsvToDatabase: typeof Database.importCsvToDatabase;
  createBoard: typeof Board.createBoard;
}

export async function loadBlockData(): Promise<BlockData> {
  const [d, b] = await Promise.all([loadDatabase(), loadBoard()]);
  return { createDatabase: d.createDatabase, importCsvToDatabase: d.importCsvToDatabase, createBoard: b.createBoard };
}
