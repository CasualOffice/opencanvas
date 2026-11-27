// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// docs/23 FC-10, prototype Import.dc.html: "Import…" in the slash menu and the "…" menu.
// Tiny and in the initial bundle; the dialog itself is a lazy chunk (components/ImportInto).
import type { Role } from "@opencanvas/ui";
import { createStore } from "./store";

export type ImportFormat = "md" | "html" | "csv" | "drawio" | "excalidraw" | "xlsx" | "ods";
const KNOWN: ImportFormat[] = ["md", "html", "csv", "drawio", "excalidraw", "xlsx", "ods"];
/** Diagram files (DGM-15): converted on the server only, after a dry-run report. */
export const DIAGRAM_FORMATS: ImportFormat[] = ["drawio", "excalidraw"];
/** Spreadsheet files (SHEET-08): converted on the server into a Spreadsheet block. */
export const SHEET_FORMATS: ImportFormat[] = ["xlsx", "ods"];

/** Formats this person may import. The host's `import_formats` flag reaches the editor as
 *  `session.import.formats`; absent or empty hides the entry. `#demo` imports locally, so it
 *  offers the formats the browser can convert (not diagrams: their converter is on the server). */
export function importFormats(session: { import?: { formats?: unknown } | null; demo?: boolean }, role: Role): ImportFormat[] {
  if (role !== "edit") return [];
  if (session.demo) return ["md", "html", "csv"];
  const f = session.import?.formats;
  return Array.isArray(f) ? f.filter((x): x is ImportFormat => KNOWN.includes(x as ImportFormat)) : [];
}

export const importStore = createStore<{ formats: ImportFormat[] }>({ formats: [] });
/** Bumped to open the import dialog. */
export const importOpenStore = createStore(0);
export const openImport = () => importOpenStore.set(importOpenStore.get() + 1);
