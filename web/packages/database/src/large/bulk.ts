// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Bulk edit (prototype 3b, 3c): one field to one value, or delete, applied in batches of 2,000
// so other people's edits interleave, and undone as one step.

import * as Y from "yjs";
import { DB_ORIGIN, getDbMap } from "../model";
import type { CellValue } from "../types";

export const BATCH = 2000;

export interface BulkRun {
  /** Rows changed so far. */
  done: number;
  total: number;
  cancelled: boolean;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Runs `step` over `ids` in batches, each batch one transaction with the database's origin.
 * The undo manager merges every batch into one stack item (its capture window is held open for
 * the run), so one Ctrl+Z reverts all of it, also after a cancel.
 */
async function batched(doc: Y.Doc, um: Y.UndoManager | null, ids: string[], step: (m: Y.Map<unknown>, batch: string[]) => void, onProgress: (r: BulkRun) => void, cancelled: () => boolean, dbId: string): Promise<BulkRun> {
  const run: BulkRun = { done: 0, total: ids.length, cancelled: false };
  const keep = um?.captureTimeout;
  um?.stopCapturing();
  if (um) um.captureTimeout = Number.MAX_SAFE_INTEGER;
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      if (cancelled()) {
        run.cancelled = true;
        break;
      }
      const batch = ids.slice(i, i + BATCH);
      doc.transact(() => {
        const m = getDbMap(doc, dbId);
        if (m) step(m, batch);
      }, DB_ORIGIN);
      run.done += batch.length;
      onProgress({ ...run });
      if (i + BATCH < ids.length) await tick();
    }
  } finally {
    if (um) {
      um.captureTimeout = keep ?? 500;
      um.stopCapturing();
    }
  }
  return run;
}

export function bulkSet(doc: Y.Doc, dbId: string, ids: string[], fid: string, value: CellValue, um: Y.UndoManager | null, onProgress: (r: BulkRun) => void = () => {}, cancelled: () => boolean = () => false) {
  return batched(doc, um, ids, (m, batch) => {
    const rows = m.get("rows") as Y.Map<Y.Map<unknown>>;
    for (const id of batch) {
      const r = rows.get(id);
      if (r instanceof Y.Map) r.set(fid, Array.isArray(value) ? value.slice() : value);
    }
  }, onProgress, cancelled, dbId);
}

export function bulkDelete(doc: Y.Doc, dbId: string, ids: string[], um: Y.UndoManager | null, onProgress: (r: BulkRun) => void = () => {}, cancelled: () => boolean = () => false) {
  return batched(doc, um, ids, (m, batch) => {
    const rows = m.get("rows") as Y.Map<Y.Map<unknown>>;
    const order = m.get("order") as Y.Array<string>;
    const gone = new Set(batch);
    for (const id of batch) rows.delete(id);
    // Delete from the end so indexes stay valid; contiguous runs in one call.
    const arr = order.toArray();
    for (let i = arr.length - 1; i >= 0; ) {
      if (!gone.has(arr[i])) {
        i--;
        continue;
      }
      let j = i;
      while (j > 0 && gone.has(arr[j - 1])) j--;
      order.delete(j, i - j + 1);
      i = j - 1;
    }
  }, onProgress, cancelled, dbId);
}
