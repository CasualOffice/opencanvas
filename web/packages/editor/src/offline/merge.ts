// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What needs a look after an offline merge (OFF-04, ADR-064, frames 4c/4d/8b). Yjs merges
// everything; only two cases are worth interrupting for:
//  1. text edited offline inside a block someone else deleted: Yjs drops it with the block, so
//     we offer it back as a new block where the old one was;
//  2. the same database cell changed on both sides: Y.Map keeps one value (by client id, not
//     "last writer"), so we show both and let the person switch.
// Concurrent text in the same paragraph, different cells and list order merge without a word.
import * as Y from "yjs";

export interface Touched {
  /** Top-level blocks (their `blockId`) changed locally. */
  blocks: Set<string>;
  /** Cells set locally: `db/row/field` → the value written. */
  cells: Map<string, { db: string; row: string; field: string; value: unknown }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyType = Y.AbstractType<any>;
const parentOf = (t: AnyType): AnyType | null => (t._item?.parent as AnyType | undefined) ?? null;
const keyOf = (t: AnyType): string | null => t._item?.parentSub ?? null;

/** Records what local transactions touch, from now on. `isLocal` decides by origin. */
export function track(doc: Y.Doc, isLocal: (origin: unknown) => boolean): Touched & { stop(): void } {
  const t: Touched = { blocks: new Set(), cells: new Map() };
  const content = doc.getXmlFragment("content");
  const dbs = doc.getMap("databases");
  const fn = (tr: Y.Transaction) => {
    if (!isLocal(tr.origin)) return;
    for (const [type, keys] of tr.changed) {
      // A block: walk up to the content fragment's child.
      let x: AnyType | null = type;
      while (x && parentOf(x) && parentOf(x) !== content) x = parentOf(x);
      if (x && parentOf(x) === content && x instanceof Y.XmlElement) {
        const id = x.getAttribute("blockId");
        if (typeof id === "string") t.blocks.add(id);
      }
      // A cell: databases/<db>/rows/<row> (a Y.Map) changed at `field`.
      const rows = parentOf(type);
      const db = rows && parentOf(rows);
      if (type instanceof Y.Map && rows && db && keyOf(rows) === "rows" && db._item?.parent === (dbs as unknown)) {
        const dbId = keyOf(db)!;
        const row = keyOf(type)!;
        for (const field of keys) if (field) t.cells.set(`${dbId}/${row}/${field}`, { db: dbId, row, field, value: type.get(field) });
      }
    }
  };
  doc.on("afterTransaction", fn);
  return { ...t, stop: () => doc.off("afterTransaction", fn) };
}

export type MergeItem =
  | { kind: "deleted"; blockId: string; title: string; text: string; index: number; prevId: string | null }
  | { kind: "cell"; db: string; row: string; field: string; rowTitle: string; fieldName: string; mine: unknown; theirs: unknown; theirsBy: number | null };

const textOf = (n: Y.XmlElement | Y.XmlText): string =>
  n instanceof Y.XmlText ? n.toString().replace(/<[^>]+>/g, "") : n.toArray().map((c) => textOf(c as Y.XmlElement)).join(n.nodeName === "paragraph" || n.nodeName === "heading" ? "" : " ");

function blocks(doc: Y.Doc): Map<string, { el: Y.XmlElement; index: number }> {
  const out = new Map<string, { el: Y.XmlElement; index: number }>();
  doc
    .getXmlFragment("content")
    .toArray()
    .forEach((n, index) => {
      if (n instanceof Y.XmlElement) {
        const id = n.getAttribute("blockId");
        if (typeof id === "string") out.set(id, { el: n, index });
      }
    });
  return out;
}

function anywhere(doc: Y.Doc, id: string): boolean {
  let found = false;
  const walk = (n: Y.XmlElement | Y.XmlFragment) => {
    for (const c of n.toArray()) {
      if (found) return;
      if (c instanceof Y.XmlElement) {
        if (c.getAttribute("blockId") === id) found = true;
        else walk(c);
      }
    }
  };
  walk(doc.getXmlFragment("content"));
  return found;
}

const cellLabel = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? ((v as { name?: string }).name ?? JSON.stringify(v)) : String(v));
export { cellLabel };

/** Compares the device's document before the merge (`before`, a Yjs state) with the merged one. */
export function analyze(before: Uint8Array, doc: Y.Doc, touched: Touched): MergeItem[] {
  const pre = new Y.Doc();
  Y.applyUpdate(pre, before);
  const out: MergeItem[] = [];
  const preBlocks = blocks(pre);
  const order = pre.getXmlFragment("content").toArray();
  for (const id of touched.blocks) {
    const b = preBlocks.get(id);
    if (!b || anywhere(doc, id)) continue;
    const prev = b.index > 0 ? order[b.index - 1] : null;
    const text = textOf(b.el).trim();
    if (!text) continue;
    // The nearest heading above names the block ("Risks").
    let title = "";
    for (let i = b.index; i >= 0 && !title; i--) {
      const n = order[i];
      if (n instanceof Y.XmlElement && n.nodeName === "heading") title = textOf(n).trim();
    }
    out.push({ kind: "deleted", blockId: id, title: title || text.slice(0, 40), text, index: b.index, prevId: prev instanceof Y.XmlElement ? ((prev.getAttribute("blockId") as string) ?? null) : null });
  }
  const dbs = doc.getMap("databases");
  for (const c of touched.cells.values()) {
    const db = dbs.get(c.db) as Y.Map<unknown> | undefined;
    const row = (db?.get("rows") as Y.Map<Y.Map<unknown>> | undefined)?.get(c.row);
    if (!db || !row) continue;
    const theirs = row.get(c.field);
    if (JSON.stringify(theirs) === JSON.stringify(c.value)) continue;
    const fields = ((db.get("fields") as Y.Array<Y.Map<unknown>> | undefined)?.toArray() ?? []).map((f) => ({ id: f.get("id") as string, name: f.get("name") as string, type: f.get("type") as string }));
    const titleField = fields.find((f) => f.type === "title") ?? fields[0];
    const item = (row as unknown as { _map: Map<string, Y.Item> })._map.get(c.field);
    out.push({
      kind: "cell",
      db: c.db,
      row: c.row,
      field: c.field,
      rowTitle: cellLabel(titleField ? row.get(titleField.id) : "") || "A row",
      fieldName: fields.find((f) => f.id === c.field)?.name ?? c.field,
      mine: c.value,
      theirs,
      theirsBy: item ? item.id.client : null,
    });
  }
  return out;
}

/** Puts a deleted block back from the device's copy as a new block where it was; returns its
 *  new `blockId` (for Undo). One transaction. */
export function restoreBlock(before: Uint8Array, doc: Y.Doc, item: Extract<MergeItem, { kind: "deleted" }>, newId: string, restoredBy: string): string | null {
  const pre = new Y.Doc();
  Y.applyUpdate(pre, before);
  const src = blocks(pre).get(item.blockId)?.el;
  if (!src) return null;
  const copy = src.clone();
  copy.setAttribute("blockId", newId);
  copy.setAttribute("restoredBy", restoredBy);
  const frag = doc.getXmlFragment("content");
  doc.transact(() => {
    const now = blocks(doc);
    const at = item.prevId && now.has(item.prevId) ? now.get(item.prevId)!.index + 1 : Math.min(item.index, frag.length);
    frag.insert(at, [copy]);
  });
  return newId;
}

/** Removes a restored block again (Undo). */
export function removeBlock(doc: Y.Doc, blockId: string): boolean {
  const b = blocks(doc).get(blockId);
  if (!b) return false;
  doc.getXmlFragment("content").delete(b.index, 1);
  return true;
}

/** "Use mine": writes the device's value back into the cell. */
export function useMine(doc: Y.Doc, item: Extract<MergeItem, { kind: "cell" }>) {
  const db = doc.getMap("databases").get(item.db) as Y.Map<unknown> | undefined;
  const row = (db?.get("rows") as Y.Map<Y.Map<unknown>> | undefined)?.get(item.row);
  row?.set(item.field, item.mine);
}
