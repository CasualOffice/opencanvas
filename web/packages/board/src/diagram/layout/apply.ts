// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Applying a layout plan (DGM-14.6): every position, the cleared bends and the refreshed connector
// points in ONE Yjs transaction, so one Undo puts everything back (6c).
import * as Y from "yjs";
import { getBoardMap, moveShapes, readShapes, updateShape, type Shape } from "../../model";
import { syncBoundArrows } from "../../connectors";
import type { LayoutPlan } from "./compute";

export function applyLayout(doc: Y.Doc, boardId: string, plan: LayoutPlan, keepBends: boolean, origin?: unknown) {
  const m = getBoardMap(doc, boardId);
  if (!m) return;
  doc.transact(() => {
    moveShapes(
      doc,
      boardId,
      plan.moves.map(({ id, to }) => ({ id, patch: { x: to[0], y: to[1], w: to[2], h: to[3] } as Partial<Shape> })),
      origin,
    );
    if (!keepBends) {
      const have = new Set(readShapes(m).filter((s) => s.via?.length).map((s) => s.id));
      for (const id of plan.connectors) if (have.has(id)) updateShape(doc, boardId, id, { via: undefined }, origin);
    }
    syncBoundArrows(doc, boardId, origin);
  }, origin);
}
