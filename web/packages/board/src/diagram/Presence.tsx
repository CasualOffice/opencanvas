// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Working together (DGM-14 S10, prototype 10a-10c; ADR-045 §6).
// - Others' selections and rings are drawn by the board (`peerSel`); this adds the panel notice
//   "Lea is editing this shape too" (`PeerNotice`).
// - Orphan connector (10b): someone deletes a shape a connector is bound to. The binding stays
//   (it is document data and keeps the shape id), so the end reattaches by itself when the shape
//   comes back (undo). Meanwhile the connector is drawn red and dashed, with a faint outline of the
//   deleted shape at its loose end (`OrphanLayer`), and the panel offers Reconnect / Delete
//   (`OrphanNotice`). The outline comes from what this view last saw of the shape (`remember`);
//   nothing is written to the document for it.
import { memo, useMemo, useState } from "react";
import * as Y from "yjs";
import { Link2Off, Users } from "lucide-react";
import { bbox, deleteShape, updateShape, type Pt, type Shape } from "../model";
import { isBinding, snapTarget, type Binding } from "../connectors";

const SW = 1.75;

/** What this view last saw of each shape: its box and name, per board. */
const seen = new Map<string, Map<string, { box: [number, number, number, number]; name: string }>>();
const nameOf = (s: Shape) => (s.text?.split("\n")[0] || s.label || s.kind?.split(":")[1] || "Shape").slice(0, 60);

/** Records the boxes of the board's shapes (called with every render's shapes). */
export function remember(boardId: string, shapes: Shape[]) {
  let m = seen.get(boardId);
  if (!m) seen.set(boardId, (m = new Map()));
  for (const s of shapes) if (s.type !== "arrow" && s.type !== "pen") m.set(s.id, { box: bbox(s), name: nameOf(s) });
}
export const lastSeen = (boardId: string, id: string) => seen.get(boardId)?.get(id);

export type End = "start" | "end";
/** The ends of a connector whose bound shape is gone. */
export function looseEnds(c: Shape, has: (id: string) => boolean): End[] {
  if (c.type !== "arrow") return [];
  return (["start", "end"] as const).filter((k) => isBinding(c[k]) && !has((c[k] as Binding).shapeId));
}

/** Red dashed orphan connectors and the faint outline of the deleted shape (10b). */
export const OrphanLayer = memo(function OrphanLayer({ boardId, shapes, z }: { boardId: string; shapes: Shape[]; z: number }) {
  const ids = useMemo(() => new Set(shapes.map((s) => s.id)), [shapes]);
  remember(boardId, shapes);
  const out = [];
  for (const c of shapes) {
    const ends = looseEnds(c, (id) => ids.has(id));
    if (!ends.length || !c.pts || c.pts.length < 2) continue;
    out.push(
      <g key={c.id} data-orphan={c.id} pointerEvents="none">
        <path d={"M" + c.pts.map((q) => q.join(" ")).join(" L")} fill="none" stroke="var(--red-fg)" strokeWidth={2 / z} strokeDasharray={`${6 / z} ${4 / z}`} />
        {ends.map((k) => {
          const gone = lastSeen(boardId, (c[k] as Binding).shapeId);
          const p = k === "start" ? c.pts![0]! : c.pts![c.pts!.length - 1]!;
          return (
            <g key={k}>
              {gone ? (
                <g data-ghost={(c[k] as Binding).shapeId} opacity={0.45}>
                  <rect x={gone.box[0]} y={gone.box[1]} width={gone.box[2] - gone.box[0]} height={gone.box[3] - gone.box[1]} rx={6} fill="none" stroke="var(--fg-2)" strokeDasharray={`${4 / z} ${4 / z}`} strokeWidth={1 / z} />
                  <text x={(gone.box[0] + gone.box[2]) / 2} y={(gone.box[1] + gone.box[3]) / 2 + 4} textAnchor="middle" fontSize={12} fill="var(--fg-2)">{gone.name}</text>
                </g>
              ) : null}
              <circle cx={p[0]} cy={p[1]} r={4 / z} fill="var(--app)" stroke="var(--red-fg)" strokeWidth={2 / z} />
            </g>
          );
        })}
      </g>,
    );
  }
  return out.length ? <g className="ocdg-orphans">{out}</g> : null;
});

/** "Lea is editing this shape too" (10a), for each other person who has a selected shape selected. */
export function PeerNotice({ peers, ids }: { peers: { id: number; name: string; color: string; sel?: string[] }[]; ids: string[] }) {
  const with_ = peers.filter((p) => p.sel?.some((id) => ids.includes(id)));
  if (!with_.length) return null;
  const first = with_[0]!.name.split(/\s+/)[0];
  const who = with_.length === 1 ? first : `${first} and ${with_.length - 1} other${with_.length > 2 ? "s" : ""}`;
  return (
    <p className="ocdg-peer" role="status">
      <span className="ocdg-pav" aria-hidden="true">
        {with_.slice(0, 3).map((p) => (
          <span key={p.id} style={{ background: p.color }}>{p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")}</span>
        ))}
        {with_.length > 3 ? <Users size={12} strokeWidth={SW} /> : null}
      </span>
      <span>
        {who} {with_.length === 1 ? "is" : "are"} editing this {ids.length > 1 ? "selection" : "shape"} too. If you change different fields, both changes are kept.
      </span>
    </p>
  );
}

/** Reattaches a loose end to the shape nearest its point (within `pad`). */
export function reconnect(doc: Y.Doc, boardId: string, c: Shape, shapes: Shape[], origin?: unknown, pad = 120): boolean {
  const live = new Set(shapes.map((s) => s.id));
  const patch: Partial<Shape> = {};
  for (const k of looseEnds(c, (id) => live.has(id))) {
    const p: Pt | undefined = k === "start" ? c.pts?.[0] : c.pts?.[c.pts.length - 1];
    if (!p) continue;
    const other = (k === "start" ? c.end : c.start) as Binding | undefined;
    const b = snapTarget(shapes.filter((s) => s.type !== "arrow" && s.type !== "pen"), p, pad, other?.shapeId);
    if (b) patch[k] = b;
  }
  if (!Object.keys(patch).length) return false;
  updateShape(doc, boardId, c.id, patch, origin);
  return true;
}

/** The orphan connector's notice and actions in the panel (10b). */
export function OrphanNotice({ doc, boardId, c, shapes, edit, origin }: { doc: Y.Doc; boardId: string; c: Shape; shapes: Shape[]; edit: boolean; origin?: unknown }) {
  const [miss, setMiss] = useState(false);
  const live = new Set(shapes.map((s) => s.id));
  const ends = looseEnds(c, (id) => live.has(id));
  if (!ends.length) return null;
  const gone = lastSeen(boardId, (c[ends[0]!] as Binding).shapeId)?.name ?? "The shape";
  return (
    <div className="ocdg-orphan" role="status">
      <p>
        <Link2Off size={14} strokeWidth={SW} aria-hidden="true" />
        <span>
          {gone} was deleted. The connector remembers it, so it reattaches if the shape comes back (for example, with undo).
        </span>
      </p>
      {edit ? (
        <div className="ocdg-oa">
          <button type="button" className="ocdg-bb" onClick={() => setMiss(!reconnect(doc, boardId, c, shapes, origin))}>
            Reconnect
          </button>
          <button type="button" className="ocdg-bb danger" onClick={() => deleteShape(doc, boardId, c.id, origin)}>
            Delete connector
          </button>
        </div>
      ) : null}
      {miss ? <p className="ocdg-hint">No shape near the loose end. Drag the end onto a shape.</p> : null}
    </div>
  );
}

export const PRESENCE_CSS = `
.ocdg-peer{display:flex;align-items:flex-start;gap:.5rem;margin:0 1rem .5rem;padding:.5rem .625rem;border-radius:.5rem;background:var(--sunk);font-size:.75rem;color:var(--fg)}
.ocdg-pav{display:inline-flex;flex:none}
.ocdg-pav span{width:1.25rem;height:1.25rem;border-radius:50%;display:inline-grid;place-items:center;color:#fff;font-size:.5625rem;font-weight:600;box-shadow:0 0 0 2px var(--sunk);margin-right:-.25rem}
.ocdg-orphan{margin:0 1rem .5rem;padding:.625rem .75rem;border-radius:.5rem;background:var(--red-bg);color:var(--red-fg);font-size:.8125rem}
.ocdg-orphan p{display:flex;gap:.5rem;margin:0}
.ocdg-orphan svg{margin-top:.1875rem}
.ocdg-oa{display:flex;gap:.5rem;margin-top:.5rem}
.ocdg-bb.danger{color:var(--red-fg)}
`;
