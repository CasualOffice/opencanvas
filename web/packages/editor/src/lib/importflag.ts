// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// docs/23 FC-10, prototype Import.dc.html: "Import…" in the slash menu and the "…" menu.
// Tiny and in the initial bundle; the dialog itself is a lazy chunk (components/ImportInto).
import type { Role } from "@opencanvas/ui";
import { createStore } from "./store";

export type ImportFormat = "md" | "html" | "csv";

/** Formats this person may import. The host's `import_formats` flag reaches the editor as
 *  `session.import.formats`; absent or empty hides the entry. `#demo` imports locally. */
export function importFormats(session: { import?: { formats?: unknown } | null; demo?: boolean }, role: Role): ImportFormat[] {
  if (role !== "edit") return [];
  if (session.demo) return ["md", "html", "csv"];
  const f = session.import?.formats;
  return Array.isArray(f) ? f.filter((x): x is ImportFormat => x === "md" || x === "html" || x === "csv") : [];
}

export const importStore = createStore<{ formats: ImportFormat[] }>({ formats: [] });
/** Bumped to open the import dialog. */
export const importOpenStore = createStore(0);
export const openImport = () => importOpenStore.set(importOpenStore.get() + 1);
