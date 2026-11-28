// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Applying a layout plan (DGM-14.6): every position, the cleared bends and the refreshed connector
// points in ONE Yjs transaction, so one Undo puts everything back (6c). BRD-09: the same
// transaction records what the plan found drawn inside frames (`props.parent`) and binds loose
// connector ends that touched a shape, so they stay with what they were drawn on.
import * as Y from "yjs";
import { getBoardMap, moveShapes, readShapes, updateShape, type Shape } from "../../model";
import { syncBoundArrows } from "../../connectors";
import type { LayoutPlan } from "./compute";

export function applyLayout(doc: Y.Doc, boardId: string, plan: LayoutPlan, keepBends: boolean, origin?: unknown) {
  const m = getBoardMap(doc, boardId);
  if (!m) return;
  doc.transact(() => {
    for (const [id, parent] of plan.parents ?? []) updateShape(doc, boardId, id, { props: { parent } }, origin);
    for (const b of plan.binds ?? []) {
      const patch: Partial<Shape> = {};
      if (b.start) patch.start = b.start;
      if (b.end) patch.end = b.end;
      updateShape(doc, boardId, b.id, patch, origin);
    }
    moveShapes(
      doc,
      boardId,
      plan.moves.map(({ id, to, patch }) => ({ id, patch: (patch ?? { x: to[0], y: to[1], w: to[2], h: to[3] }) as Partial<Shape> })),
      origin,
    );
    if (!keepBends) {
      const have = new Set(readShapes(m).filter((s) => s.via?.length).map((s) => s.id));
      for (const id of plan.connectors) if (have.has(id)) updateShape(doc, boardId, id, { via: undefined }, origin);
    }
    syncBoundArrows(doc, boardId, origin);
  }, origin);
}
