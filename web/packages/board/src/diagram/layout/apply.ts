// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Applying a layout plan (DGM-14.6): every position, the cleared bends and the refreshed connector
// points in ONE Yjs transaction, so one Undo puts everything back (6c). BRD-09: the same
// transaction records what the plan found drawn inside frames (`props.parent`) and binds loose
// connector ends that touched a shape, so they stay with what they were drawn on.
import * as Y from "yjs";
import { getBoardMap, moveShapes, readShapes, updateShape, type Shape } from "../../model";
import { facing, isBinding, syncBoundArrows } from "../../connectors";
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
      const now = readShapes(m);
      const have = new Set(now.filter((s) => s.via?.length).map((s) => s.id));
      for (const id of plan.connectors) if (have.has(id)) updateShape(doc, boardId, id, { via: undefined }, origin);
      // BRD-38: routed again means from the sides that now face each other (a right-to-left
      // connector between shapes stacked by "Down" leaves the bottom for the top). Centre-bound
      // ends and named ports keep theirs.
      const byId = new Map(now.map((s) => [s.id, s]));
      const mid = (s: Shape): [number, number] => [(s.x ?? 0) + (s.w ?? 0) / 2, (s.y ?? 0) + (s.h ?? 0) / 2];
      for (const id of plan.connectors) {
        const a = byId.get(id);
        if (!a || !isBinding(a.start) || !isBinding(a.end) || a.start.port || a.end.port || a.start.anchor === "center" || a.end.anchor === "center") continue;
        const bs = byId.get(a.start.shapeId), be = byId.get(a.end.shapeId);
        if (!bs || !be) continue;
        const sa = facing(bs, mid(be)), sb = facing(be, mid(bs));
        if (sa !== a.start.anchor || sb !== a.end.anchor) updateShape(doc, boardId, id, { start: { ...a.start, anchor: sa }, end: { ...a.end, anchor: sb } }, origin);
      }
    }
    syncBoundArrows(doc, boardId, origin);
  }, origin);
}
