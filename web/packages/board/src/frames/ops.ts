// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Frame edits (BRD-21): draw, join by centre-drop, release on delete, rename.
import * as Y from "yjs";
import { addShape, getBoardMap, updateShape, type Shape } from "../model";
import { CONTAINER } from "../kinds";
import { makeNode } from "../registry";
import { adopted, frameName, isFrame, membershipChanges, nextFrameName, parentOf } from "./model";

type Box = [number, number, number, number];

/** Draws a frame over `box`, adopting the free shapes whose centre is in it; it goes to the back. */
export function createFrame(doc: Y.Doc, boardId: string, shapes: Shape[], box: Box, origin: unknown): string {
  let id = "";
  doc.transact(() => {
    const s = makeNode(CONTAINER, { x: Math.round(box[0]), y: Math.round(box[1]), w: Math.round(box[2] - box[0]), h: Math.round(box[3] - box[1]), label: nextFrameName(shapes) });
    id = addShape(doc, boardId, s, origin);
    for (const m of adopted(shapes, { ...s, id } as Shape)) updateShape(doc, boardId, m, { props: { parent: id } }, origin);
    const order = getBoardMap(doc, boardId)?.get("order");
    if (order instanceof Y.Array) {
      const at = (order.toArray() as string[]).lastIndexOf(id);
      if (at > 0) {
        order.delete(at, 1);
        order.insert(0, [id]);
      }
    }
  }, origin);
  return id;
}

/** After a move: shapes whose centre now lies in another frame (or none) change frame. Returns what to say. */
export function applyMembership(doc: Y.Doc, boardId: string, shapes: Shape[], moved: string[], origin: unknown): string | null {
  const changes = membershipChanges(shapes, moved);
  if (!changes.length) return null;
  const byId = new Map(shapes.map((s) => [s.id, s]));
  for (const [id, parent] of changes) updateShape(doc, boardId, id, { props: { parent: parent ?? undefined } }, origin);
  const joined = changes.find(([, p]) => p);
  if (joined) return `Added to ${frameName(byId.get(joined[1]!)!)}`;
  const left = byId.get(changes[0]![0]);
  const was = left && parentOf(left) ? byId.get(parentOf(left)!) : undefined;
  return was ? `Removed from ${frameName(was)}` : null;
}

/** Before frames are deleted: their members move up to the deleted frame's own parent (or none). */
export function releaseMembers(doc: Y.Doc, boardId: string, shapes: Shape[], deleting: string[], origin: unknown) {
  const gone = new Set(deleting);
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const up = (id: string | null): string | null => {
    while (id && gone.has(id)) id = parentOf(byId.get(id) ?? ({} as Shape));
    return id;
  };
  for (const s of shapes) {
    const p = parentOf(s);
    if (!p || gone.has(s.id) || !gone.has(p) || !isFrame(byId.get(p) ?? ({} as Shape))) continue;
    updateShape(doc, boardId, s.id, { props: { parent: up(p) ?? undefined } }, origin);
  }
}

export function renameFrame(doc: Y.Doc, boardId: string, id: string, name: string, origin: unknown) {
  const v = name.trim().slice(0, 80);
  if (v) updateShape(doc, boardId, id, { label: v }, origin);
}
