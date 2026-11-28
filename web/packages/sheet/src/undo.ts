// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SHEET-07 (frame 6a): undo reverts your own step only. If someone changed a cell of that step
// since, their newer value stays and the caller says so ("1 cell kept Lea's newer value").
//
// Yjs already keeps a newer value written over one of your map entries. It does not when your
// step created the cell's map (the cell was empty): undoing deletes that map with everything in
// it, the newer value included. So the values to keep are read before the undo and written back
// after it, under an origin the undo manager does not track.

import * as Y from "yjs";

export interface Kept {
  /** Cells whose newer value (someone else's) was kept. */
  cells: number;
  /** Their Yjs client ids, in order of first appearance. */
  by: number[];
}

interface Keep {
  cells: Y.Map<unknown>;
  key: string;
  sub: string;
  value: unknown;
  client: number;
}

/** The `cells` map a cell map lives in, or null when `m` is not a cell. */
function cellsOf(m: { _item: Y.Item | null } | null): Y.Map<unknown> | null {
  const it = m?._item;
  const parent = it?.parent as unknown;
  return it && it.parentSub && parent instanceof Y.Map && parent._item?.parentSub === "cells" ? parent : null;
}

/** Entries of cell map `m` last written by another client: what the undo must not lose. */
function others(m: Y.Map<unknown>, me: number, push: (sub: string, value: unknown, client: number) => void) {
  m._map.forEach((item, sub) => {
    if (!item.deleted && item.id.client !== me) push(sub, m.get(sub), item.id.client);
  });
}

/** Undoes the top step of `um`, keeping newer values others wrote over it. */
export function undoKeeping(doc: Y.Doc, um: Y.UndoManager, origin: unknown): Kept {
  const top = um.undoStack[um.undoStack.length - 1];
  if (!top) return { cells: 0, by: [] };
  const me = doc.clientID;
  const keep: Keep[] = [];
  const add = (cells: Y.Map<unknown>, key: string) => (sub: string, value: unknown, client: number) => keep.push({ cells, key, sub, value, client });
  top.insertions.clients.forEach((ranges, client) => {
    const structs = doc.store.clients.get(client);
    if (!structs) return;
    for (const { clock, len } of ranges) {
      for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < clock + len; i++) {
        const s = structs[i];
        if (!(s instanceof Y.Item) || s.parentSub == null) continue;
        const parent = s.parent as Y.AbstractType<unknown>;
        if (parent instanceof Y.Map && parent._item?.parentSub === "cells") {
          // This step created the cell (its map is about to go): keep what others wrote in it.
          if (s.deleted) continue;
          const cell = s.content.getContent()[0];
          if (cell instanceof Y.Map) others(cell, me, add(parent, s.parentSub));
          continue;
        }
        const cells = cellsOf(parent);
        if (!cells || !s.deleted || !(parent instanceof Y.Map)) continue;
        // This step wrote an entry of an existing cell, and someone wrote over it since.
        const now = parent._map.get(s.parentSub);
        if (now && !now.deleted && now.id.client !== me) keep.push({ cells, key: parent._item!.parentSub!, sub: s.parentSub, value: parent.get(s.parentSub), client: now.id.client });
      }
    }
  });
  um.undo();
  if (!keep.length) return { cells: 0, by: [] };
  doc.transact(() => {
    for (const k of keep) {
      let c = k.cells.get(k.key);
      if (!(c instanceof Y.Map)) {
        c = new Y.Map<unknown>();
        k.cells.set(k.key, c);
      }
      const m = c as Y.Map<unknown>;
      if (m.get(k.sub) !== k.value) m.set(k.sub, k.value);
    }
  }, origin);
  const cells = new Set(keep.map((k) => k.key));
  const by: number[] = [];
  for (const k of keep) if (!by.includes(k.client)) by.push(k.client);
  return { cells: cells.size, by };
}
