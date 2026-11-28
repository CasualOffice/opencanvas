// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Frames (BRD-21, board UX prototype 5a-5c, decision 6): a named area stored as the existing
// `diagram:container` kind. Membership is explicit: a member names its frame in `props.parent`
// (as BRD-09's auto-layout writes), so auto-layout, export and the outline agree. A shape joins the
// frame its centre is dropped in; deleting a frame keeps its contents.
import { bbox, type Shape } from "../model";
import { isContainer } from "../kinds";

export const FRAME_SIZE = { w: 360, h: 240 };

export const isFrame = (s: Shape) => isContainer(s);
export const frameName = (s: Shape) => String(s.label || s.text || "Frame").slice(0, 80);
export const parentOf = (s: Shape) => (typeof s.props?.parent === "string" ? (s.props.parent as string) : null);

/** Frames in board order (the zoom menu and Present step through them in this order). */
export const framesOf = (shapes: Shape[]) => shapes.filter(isFrame);

/** A name not used yet: "Frame 1", "Frame 2", ... */
export function nextFrameName(shapes: Shape[]): string {
  const used = new Set(framesOf(shapes).map(frameName));
  for (let i = 1; ; i++) if (!used.has(`Frame ${i}`)) return `Frame ${i}`;
}

/**
 * The frame a point lies in: the innermost (smallest) frame whose box holds it, skipping `skip`
 * (the shapes being moved, so a frame never joins itself or its own members).
 */
export function frameAt(shapes: Shape[], x: number, y: number, skip: ReadonlySet<string> = new Set()): Shape | null {
  let best: Shape | null = null;
  let area = Infinity;
  for (const f of shapes) {
    if (!isFrame(f) || skip.has(f.id)) continue;
    const [x0, y0, x1, y1] = bbox(f);
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const a = (x1 - x0) * (y1 - y0);
    if (a < area) (best = f), (area = a);
  }
  return best;
}

/** Every shape that names `frameId` as its parent, through nested frames. */
export function membersOf(shapes: Shape[], frameId: string): string[] {
  const out = new Set([frameId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of shapes) {
      const p = parentOf(s);
      if (p && out.has(p) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  out.delete(frameId);
  return [...out];
}

/**
 * Where moved shapes now belong (centre-drop): `[id, frame id or null]` for each moved shape whose
 * frame changed. Connectors and drawings never join; a frame moved with its own parent keeps it.
 */
export function membershipChanges(shapes: Shape[], moved: string[]): [string, string | null][] {
  const set = new Set(moved);
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const out: [string, string | null][] = [];
  for (const id of moved) {
    const s = byId.get(id);
    if (!s || s.type === "arrow" || s.type === "pen") continue;
    const cur = parentOf(s);
    // Moving with its frame: keep it.
    if (cur && set.has(cur)) continue;
    const [x0, y0, x1, y1] = bbox(s);
    // Never inside itself or one of its own members (a frame dropped into its child).
    const skip = new Set([id, ...(isFrame(s) ? membersOf(shapes, id) : [])]);
    const f = frameAt(shapes, (x0 + x1) / 2, (y0 + y1) / 2, skip);
    const next = f ? f.id : null;
    if (next !== cur) out.push([id, next]);
  }
  return out;
}

/** Shapes a newly drawn frame adopts: those whose centre lies in its box and that have no frame. */
export function adopted(shapes: Shape[], frame: Shape): string[] {
  const [fx0, fy0, fx1, fy1] = bbox(frame);
  return shapes
    .filter((s) => {
      if (s.id === frame.id || s.type === "arrow" || s.type === "pen" || parentOf(s)) return false;
      const [x0, y0, x1, y1] = bbox(s);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      return cx >= fx0 && cx <= fx1 && cy >= fy0 && cy <= fy1 && (isFrame(s) ? (x1 - x0) * (y1 - y0) < (fx1 - fx0) * (fy1 - fy0) : true);
    })
    .map((s) => s.id);
}
