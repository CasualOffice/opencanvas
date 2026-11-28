// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// How frames look on the board (BRD-21, prototype 5a): a plain area drawn under everything, its
// name above the top-left corner at a constant screen size. Clicks inside reach the canvas; the
// frame is picked by its name or its edge. Double-click the name (or F2) to rename (the board's
// double-click handler, since pointer capture retargets dblclick to the <svg>).
import { memo, useEffect, useRef, useState } from "react";
import type { Shape } from "../model";
import { frameName } from "./model";

/** The frame's body: drawn, but only its edge takes the pointer. */
export function FrameView({ s, drop }: { s: Shape; drop?: boolean }) {
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  return (
    <g data-s={s.id} data-frame={s.id} style={{ cursor: "move" }}>
      <rect x={x} y={y} width={w} height={h} rx={6} fill="var(--app)" stroke={drop ? "var(--accent)" : "var(--line-2)"} strokeWidth={drop ? 2 : 1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
      <rect x={x} y={y} width={w} height={h} rx={6} fill="none" stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />
    </g>
  );
}

/** Frame names above their top-left corners, 12 px on screen whatever the zoom. */
export const FrameNames = memo(function FrameNames({ frames, z, selected }: { frames: Shape[]; z: number; selected: ReadonlySet<string> }) {
  if (!frames.length) return null;
  return (
    <g className="ocbd-fnames">
      {frames.map((f) => {
        const name = frameName(f);
        const x = f.x ?? 0, y = f.y ?? 0;
        return (
          <g key={f.id} data-s={f.id} data-frame-name={f.id} style={{ cursor: "move" }}>
            <rect x={x} y={y - 20 / z} width={Math.max(40, name.length * 7 + 8) / z} height={18 / z} fill="transparent" />
            <text x={x + 2 / z} y={y - 7 / z} fontSize={12 / z} fontWeight={selected.has(f.id) ? 600 : 500} fill={selected.has(f.id) ? "var(--accent)" : "var(--fg-2)"}>
              {name}
            </text>
          </g>
        );
      })}
    </g>
  );
});

/** The rename field over a frame's name (screen coordinates). Enter or leaving saves; Esc cancels. */
export function FrameRename({ frame, view, onDone }: { frame: Shape; view: { tx: number; ty: number; z: number }; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(frameName(frame));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const left = (frame.x ?? 0) * view.z + view.tx, top = (frame.y ?? 0) * view.z + view.ty;
  return (
    <input
      ref={ref}
      className="ocbd-frename"
      aria-label="Frame name"
      value={v}
      maxLength={80}
      style={{ position: "absolute", left, top: `calc(${top}px - 1.5rem)`, zIndex: 6, width: "14rem", font: "inherit", fontSize: "0.75rem", fontWeight: 600, padding: "0.125rem 0.375rem", border: "1px solid var(--accent)", borderRadius: "0.375rem", background: "var(--app)", color: "var(--fg)" }}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(v)}
    />
  );
}
