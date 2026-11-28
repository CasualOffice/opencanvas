// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// App mode for typed files (FTY-02..05, docs/05 §2f): a spreadsheet, whiteboard or database
// file is one root block shown full page. Content that is not exactly that opens as a document,
// unchanged (`appFallback: "content"`).

import { useSyncExternalStore } from "react";
import { appMode, type AppMode } from "./wording";

interface Node {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
}

const NODE: Record<AppMode, [string, string]> = {
  spreadsheet: ["spreadsheet", "sheetId"],
  whiteboard: ["board", "boardId"],
  database: ["database", "dbId"],
};

const blank = (n: Node) => n.type === "paragraph" && !(n.content ?? []).some((c) => (c.text ?? "").trim() || c.type !== "text");

/** The root block of a typed file, or why there is none. */
export function appRootOf(doc: Node, app: AppMode): { id: string } | { fallback: "content" } | { empty: true } {
  const [type, attr] = NODE[app];
  const top = (doc.content ?? []).filter((n) => !blank(n));
  if (!top.length) return { empty: true };
  if (top.length === 1 && top[0]!.type === type && typeof top[0]!.attrs?.[attr] === "string") return { id: top[0]!.attrs![attr] as string };
  return { fallback: "content" };
}

const isApp = (v: unknown): v is AppMode => v === "spreadsheet" || v === "whiteboard" || v === "database";

/**
 * The app mode of this open: the launch's fragment, else the session's `app` (docs/05 §2f), else
 * the type the file itself records (`meta.app`, written into the manifest), so a downloaded
 * spreadsheet reopens as one in any host.
 */
export function resolveApp(hash: string, sessionApp: unknown, metaApp: unknown): AppMode | null {
  return appMode(hash) ?? (isApp(sessionApp) ? sessionApp : isApp(metaApp) ? metaApp : null);
}

let root: string | null = null;
const subs = new Set<() => void>();

/** The id of the block shown as the file in app mode (`null`: a document). */
export function setAppRoot(id: string | null) {
  if (root === id) return;
  root = id;
  subs.forEach((f) => f());
}

export function useIsAppRoot(id: string): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => root !== null && root === id,
  );
}
