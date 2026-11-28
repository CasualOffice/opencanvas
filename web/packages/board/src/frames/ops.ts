// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Frame edits (BRD-21): draw, join by centre-drop, release on delete, rename.
import * as Y from "yjs";
import { addShape, bbox, deleteShape, getBoardMap, updateShape, type Shape } from "../model";
import { CONTAINER } from "../kinds";
import { makeNode } from "../registry";
import { adopted, frameName, isFrame, membersOf, membershipChanges, nextFrameName, parentOf } from "./model";

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

/** Space between a wrapped selection and its new frame's edge (prototype 3a). */
export const WRAP_PAD = 24;

/**
 * Wrap in frame (⇧F): a new frame 24 units around `ids` (frames among them are left out). The
 * shapes join it (connectors and drawings stay free, as with centre-drop); it nests in the frame
 * they all shared and is drawn just behind the lowest of them. Returns the frame's id and name.
 */
export function wrapInFrame(doc: Y.Doc, boardId: string, shapes: Shape[], ids: string[], origin: unknown): { id: string; name: string } | null {
  const want = new Set(ids);
  const list = shapes.filter((s) => want.has(s.id) && !isFrame(s));
  if (!list.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of list) {
    const b = bbox(s);
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  const joins = list.filter((s) => s.type !== "arrow" && s.type !== "pen");
  const parents = new Set(joins.map(parentOf));
  const shared = parents.size === 1 ? [...parents][0] : null;
  const name = nextFrameName(shapes);
  let id = "";
  doc.transact(() => {
    const f = makeNode(CONTAINER, { x: Math.round(x0 - WRAP_PAD), y: Math.round(y0 - WRAP_PAD), w: Math.round(x1 - x0 + WRAP_PAD * 2), h: Math.round(y1 - y0 + WRAP_PAD * 2), label: name });
    id = addShape(doc, boardId, f, origin);
    if (shared) updateShape(doc, boardId, id, { props: { parent: shared } }, origin);
    for (const s of joins) updateShape(doc, boardId, s.id, { props: { parent: id } }, origin);
    const order = getBoardMap(doc, boardId)?.get("order");
    if (order instanceof Y.Array) {
      const arr = order.toArray() as string[];
      const at = arr.lastIndexOf(id);
      const first = arr.findIndex((x) => want.has(x));
      if (at > 0 && first >= 0 && first < at) {
        order.delete(at, 1);
        order.insert(first, [id]);
      }
    }
  }, origin);
  return { id, name };
}

/**
 * Delete frame and contents: the frames, every member through nested frames, and connectors bound
 * to any of them. Locked members stay and leave the frame. Returns how many members went.
 */
export function deleteWithContents(doc: Y.Doc, boardId: string, shapes: Shape[], frameIds: string[], origin: unknown): number {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const gone = new Set<string>();
  for (const f of frameIds) {
    if (!byId.get(f) || byId.get(f)!.locked) continue;
    gone.add(f);
    for (const m of membersOf(shapes, f)) if (!byId.get(m)?.locked) gone.add(m);
  }
  if (!gone.size) return 0;
  for (const s of shapes) if (s.type === "arrow" && !s.locked && ((s.start && gone.has(s.start.shapeId)) || (s.end && gone.has(s.end.shapeId)))) gone.add(s.id);
  const members = [...gone].filter((g) => !frameIds.includes(g)).length;
  doc.transact(() => {
    releaseMembers(doc, boardId, shapes, [...gone], origin);
    for (const g of gone) deleteShape(doc, boardId, g, origin);
  }, origin);
  return members;
}
