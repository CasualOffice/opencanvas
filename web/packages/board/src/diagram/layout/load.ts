// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Dagre (MIT, ADR-047 §5) is loaded the first time someone opens Auto-layout: a dynamic import
// inside the lazy diagram chunk, so it is never in the editor's initial bundle.
import type { DagreLike } from "./compute";

let dagre: Promise<DagreLike> | null = null;
export function loadDagre(): Promise<DagreLike> {
  dagre ??= import("@dagrejs/dagre").then((m) => ((m as unknown as { default?: DagreLike }).default ?? (m as unknown as DagreLike)));
  return dagre;
}
