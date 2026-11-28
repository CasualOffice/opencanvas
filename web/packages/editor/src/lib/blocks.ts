// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// PSYNC-03: the one way to reach a database's or board's data. In a split room (ADR-076) a
// block lives in its part (its own Y.Doc), not under the main document's `databases` or
// `boards` root; a block made since the last split is still in the main document. Code that
// reads or writes blocks goes through here rather than `doc.getMap("databases")`.
import * as Y from "yjs";
import { bridge } from "./bridge";

export type BlockRoot = "databases" | "boards" | "sheets";

/** The room's parts, for the canvas's own document only (a live block's file is never split). */
const partsOf = (doc: Y.Doc) => (doc === bridge.doc ? (bridge.parts ?? null) : null);

/** The document that holds the block: its part when loaded, else `doc`. */
export function blockDoc(doc: Y.Doc, id: string): Y.Doc {
  const parts = partsOf(doc);
  return (parts?.isPart(id) && parts.doc(id)) || doc;
}

/** The block's map, wherever it lives; `undefined` when it is not there (or its part is not
 *  loaded). */
export function blockMap(doc: Y.Doc, root: BlockRoot, id: string): Y.Map<unknown> | undefined {
  const parts = partsOf(doc);
  if (parts?.isPart(id)) {
    const v = parts.doc(id)?.getMap(root).get(id);
    return v instanceof Y.Map ? v : undefined;
  }
  const v = doc.getMap(root).get(id);
  return v instanceof Y.Map ? v : undefined;
}

/** Every block of `root`: the main document's and every loaded part's. */
export function eachBlock(doc: Y.Doc, root: BlockRoot, fn: (m: Y.Map<unknown>, id: string) => void) {
  const seen = new Set<string>();
  const parts = partsOf(doc);
  for (const id of parts?.loadedIds() ?? []) {
    const m = blockMap(doc, root, id);
    if (m) (seen.add(id), fn(m, id));
  }
  doc.getMap(root).forEach((v, id) => {
    if (!seen.has(id) && v instanceof Y.Map && !parts?.isPart(id)) fn(v, id);
  });
}

/** Calls `fn` on any change to a block of `root`, in the main document or a loaded part
 *  (parts loaded later included). Returns the unsubscribe. */
export function observeBlocks(doc: Y.Doc, root: BlockRoot, fn: () => void): () => void {
  const watched = new Map<Y.Doc, Y.Map<unknown>>();
  const watch = (d: Y.Doc) => {
    if (watched.has(d)) return;
    const m = d.getMap(root);
    m.observeDeep(fn);
    watched.set(d, m);
  };
  watch(doc);
  const parts = partsOf(doc);
  const sync = () => {
    const live = new Set<Y.Doc>([doc]);
    for (const id of parts?.loadedIds() ?? []) {
      const d = parts?.doc(id);
      if (d) (live.add(d), watch(d));
    }
    for (const [d, m] of watched) if (!live.has(d)) (m.unobserveDeep(fn), watched.delete(d));
    fn();
  };
  const off = parts?.onChange(sync);
  if (parts) sync();
  return () => {
    off?.();
    for (const [, m] of watched) m.unobserveDeep(fn);
    watched.clear();
  };
}
