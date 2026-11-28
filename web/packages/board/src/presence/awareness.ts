// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What a board puts in awareness (never in the document): `board = { id, x?, y?, sel?, vp? }`.
// `vp` (decision 12) is the centre of the person's view in board units and their zoom, so others
// can follow them; 0.1.x clients ignore it.
export interface PeerBoard {
  x: number | null;
  y: number | null;
  sel: string[];
  /** [centre x, centre y, zoom] */
  vp: [number, number, number] | null;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A peer's board state, if it is on `boardId`. Anything malformed reads as absent. */
export function readPeer(b: unknown, boardId: string): PeerBoard | null {
  if (!b || typeof b !== "object") return null;
  const o = b as { id?: unknown; x?: unknown; y?: unknown; sel?: unknown; vp?: unknown };
  if (o.id !== boardId) return null;
  const pt = num(o.x) && num(o.y);
  const sel = Array.isArray(o.sel) ? o.sel.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
  const v = Array.isArray(o.vp) && o.vp.length === 3 && o.vp.every(num) && (o.vp[2] as number) > 0 ? (o.vp as [number, number, number]) : null;
  return { x: pt ? (o.x as number) : null, y: pt ? (o.y as number) : null, sel, vp: v };
}

/** This view's viewport for awareness, rounded so small jitters don't send updates. */
export function viewport(view: { tx: number; ty: number; z: number }, size: [number, number]): [number, number, number] {
  const [W, H] = size;
  const r = (v: number) => Math.round(v);
  return [r((W / 2 - view.tx) / view.z), r((H / 2 - view.ty) / view.z), Math.round(view.z * 1000) / 1000];
}

/** Text colour on a person's colour: white or near-black, whichever contrasts more (WCAG). */
export function inkOn(color: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#fff";
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const lin = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  const dark = 0.0091; // #18181b
  return 1.05 / (L + 0.05) >= (L + 0.05) / (dark + 0.05) ? "#fff" : "#18181b";
}

/** The view that shows `vp` in a board of `size`. */
export function viewFor(vp: [number, number, number], size: [number, number]): { tx: number; ty: number; z: number } {
  const [cx, cy, z] = vp;
  return { z, tx: size[0] / 2 - cx * z, ty: size[1] / 2 - cy * z };
}
