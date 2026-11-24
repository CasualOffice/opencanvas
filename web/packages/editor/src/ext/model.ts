// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SDK blocks in the editor (BSDK-02, BSDK-05; docs/15 §4.2): the packages the session lists,
// how a stored block relates to them, and the `ext` root that holds block data
// (`ext[dataId]` is a Y.Map with one key per field, so concurrent edits of different fields
// both survive and one field is last-writer-wins).
import * as Y from "yjs";
import type { Migrations } from "./migrate";

/** One entry of the session's `blocks` (docs/15 §2). */
export interface BlockPackage {
  type: string;
  version: string;
  /** Data version this package writes (its major). */
  v: number;
  title: string;
  icon?: string | null;
  description?: string | null;
  content: "none" | "inline" | "blocks";
  attrs: unknown;
  data?: unknown;
  /** Bundle URL on the block origin; null without `OC_BLOCKS_ORIGIN`. */
  entry: string | null;
  integrity: string;
  /** Present when the server lists them (BSDK-03); declarative steps only here. */
  migrations?: Migrations;
  export?: { markdown?: string; text?: string };
}

/** The stored attributes of an `extBlock` node. */
export interface ExtAttrs {
  blockId?: string | null;
  type: string;
  v: number;
  attrs: Record<string, unknown> | null;
  dataId?: string | null;
  fallback?: { markdown?: string | null; text?: string | null } | null;
}

export type Status = "missing" | "current" | "older" | "newer";

let installed = new Map<string, BlockPackage>();

/** Called with the session's `blocks` when the editor opens. */
export function setInstalledBlocks(list: BlockPackage[] | undefined): void {
  installed = new Map((list ?? []).map((p) => [p.type, p]));
}

export function installedBlock(type: string): BlockPackage | undefined {
  return installed.get(type);
}

/** How a block's stored data version relates to the package this editor has. */
export function statusOf(a: Pick<ExtAttrs, "type" | "v">, pkg = installedBlock(a.type)): Status {
  if (!pkg) return "missing";
  const v = Number(a.v) || 1;
  return v === pkg.v ? "current" : v < pkg.v ? "older" : "newer";
}

/** Editing is allowed only for current data (older data is migrated first, BSDK-05); a block
 *  from a newer version or a missing package is read-only and keeps its data untouched. */
export const editable = (s: Status) => s === "current" || s === "older";

export const EXT_ROOT = "ext";

export function extRoot(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(EXT_ROOT) as Y.Map<Y.Map<unknown>>;
}

/** A block's data as plain JSON (`{}` when it has none). */
export function readExtData(doc: Y.Doc, dataId: string | null | undefined): Record<string, unknown> {
  if (!dataId) return {};
  const m = extRoot(doc).get(dataId);
  return m instanceof Y.Map ? (m.toJSON() as Record<string, unknown>) : {};
}

/** Sets fields of a block's data, each its own key (per-field last writer wins). */
export function writeExtData(doc: Y.Doc, dataId: string, fields: Record<string, unknown>, origin?: unknown): void {
  doc.transact(() => {
    const root = extRoot(doc);
    let m = root.get(dataId);
    if (!(m instanceof Y.Map)) {
      m = new Y.Map();
      root.set(dataId, m);
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) m.delete(k);
      else m.set(k, v);
    }
  }, origin);
}

/** The plain text a block shows when its package cannot draw it. */
export function fallbackText(a: Pick<ExtAttrs, "type" | "fallback">): string {
  const f = a.fallback;
  const t = (f?.text ?? "").trim() || (f?.markdown ?? "").trim();
  if (t) return t;
  const pkg = installedBlock(a.type);
  return `Block: ${pkg?.title ?? (a.type || "unknown")}`;
}
