// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Working together (board UX prototype 10a-10b, decision 12): others' cursors with name labels that
// fade after 4 s still (the arrow stays), avatars with Follow and Go to cursor, and the frame shown
// while following. A person's colour is the same in the avatar, the cursor and the ring.
import { useEffect, useRef, useState } from "react";
import { Crosshair, Eye } from "lucide-react";
import type { Peer } from "./hooks";
import { inkOn } from "./awareness";

const SW = 1.75;
export const LABEL_FADE_MS = 4000;
const short = (n: string, max: number) => (n.length > max ? n.slice(0, max - 1) + "…" : n);
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** Cursors in screen space. A label shows while its cursor moves and fades 4 s after it stops. */
/** `width`: the board's width on screen; a label that would run past it sits left of the arrow (BRD-36). */
export function Cursors({ peers, view, width }: { peers: Peer[]; view: { tx: number; ty: number; z: number }; width?: number }) {
  const moved = useRef(new Map<number, { x: number; y: number; at: number }>());
  const [, tick] = useState(0);
  const now = Date.now();
  for (const p of peers) {
    if (p.x === null || p.y === null) continue;
    const m = moved.current.get(p.id);
    if (!m || m.x !== p.x || m.y !== p.y) moved.current.set(p.id, { x: p.x, y: p.y, at: now });
  }
  // Re-render when the next label is due to fade.
  const due = Math.min(...[...moved.current.values()].map((m) => m.at + LABEL_FADE_MS - now).filter((d) => d > 0), Infinity);
  useEffect(() => {
    if (!Number.isFinite(due)) return;
    const t = setTimeout(() => tick((n) => n + 1), due + 20);
    return () => clearTimeout(t);
  });
  return (
    <g pointerEvents="none">
      {peers.map((p) => {
        if (p.x === null || p.y === null) return null;
        const px = p.x * view.z + view.tx, py = p.y * view.z + view.ty;
        const w = Math.min(160, p.name.length * 6.6 + 16);
        const shown = now - (moved.current.get(p.id)?.at ?? now) < LABEL_FADE_MS;
        const lx = width && px + 12 + w > width ? -4 - w : 12;
        return (
          <g key={p.id} className="ocbd-cursor" transform={`translate(${px.toFixed(1)} ${py.toFixed(1)})`} style={{ transition: "transform 80ms linear" }}>
            <path d="M0 0 L5.5 15 L8 8.5 L14.5 6 Z" fill={p.color} stroke="var(--app)" strokeWidth="1.2" strokeLinejoin="round" />
            <g className="ocbd-clabel" opacity={shown ? 1 : 0} style={{ transition: "opacity 400ms ease" }}>
              <rect x={lx} y="15" width={w} height="20" rx="6" fill={p.color} />
              <text x={lx + 8} y="29" fontSize="11.5" fontWeight="600" fill={inkOn(p.color)}>{short(p.name, 22)}</text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

/** Avatars of the others here; each opens Follow / Go to cursor. */
export function Avatars({ peers, following, onFollow, onGoTo }: { peers: Peer[]; following: number | null; onFollow: (id: number) => void; onGoTo: (id: number) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!peers.length) return null;
  const shown = peers.slice(0, 4);
  const more = peers.length - shown.length;
  const who = open === null ? undefined : peers.find((p) => p.id === open);
  return (
    <div className="ocbd-people" role="group" aria-label="People on this board">
      {shown.map((p) => (
        <button
          key={p.id}
          type="button"
          className="ocbd-av"
          aria-label={p.name}
          title={p.name}
          aria-haspopup="menu"
          aria-expanded={open === p.id}
          data-following={following === p.id ? "" : undefined}
          style={{ background: p.color, color: inkOn(p.color), boxShadow: following === p.id ? `0 0 0 2px var(--app), 0 0 0 4px ${p.color}` : undefined }}
          onClick={() => setOpen((o) => (o === p.id ? null : p.id))}
        >
          {initials(p.name)}
        </button>
      ))}
      {more > 0 ? <span className="ocbd-av more" aria-label={`${more} more`}>+{more}</span> : null}
      {who ? (
        <>
          <div className="ocbd-scrim" onPointerDown={() => setOpen(null)} />
          <div
            className="ocbd-menu ocbd-avmenu"
            role="menu"
            aria-label={who.name}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.stopPropagation(), setOpen(null));
            }}
          >
            <button role="menuitem" className="ocbd-mi" disabled={!who.vp} onClick={() => (setOpen(null), onFollow(who.id))}>
              <Eye size={16} strokeWidth={SW} />
              Follow
            </button>
            <button role="menuitem" className="ocbd-mi" disabled={who.x === null} onClick={() => (setOpen(null), onGoTo(who.id))}>
              <Crosshair size={16} strokeWidth={SW} />
              Go to cursor
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The frame in their colour while following, with "Following Lea · Stop". */
export function FollowBanner({ peer, onStop }: { peer: Peer; onStop: () => void }) {
  return (
    <div className="ocbd-follow" style={{ boxShadow: `inset 0 0 0 2px ${peer.color}` }}>
      <span className="ocbd-ftag" style={{ background: peer.color, color: inkOn(peer.color) }} role="status">
        Following {short(peer.name, 28)}
        <button type="button" onClick={onStop} aria-label={`Stop following ${peer.name}`}>
          Stop
        </button>
      </span>
    </div>
  );
}

const CSS = `
.ocbd-people{display:flex;align-items:center;margin-right:.25rem;position:relative}
.ocbd-av{width:1.75rem;height:1.75rem;border-radius:50%;border:2px solid var(--app);margin-left:-.375rem;font:inherit;font-size:.6875rem;font-weight:600;display:grid;place-items:center;cursor:pointer;padding:0}
.ocbd-av:first-child{margin-left:0}
.ocbd-av.more{background:var(--sunk);color:var(--fg-2);cursor:default}
.ocbd-av:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ocbd-avmenu{position:absolute;top:calc(100% + .375rem);right:0;left:auto}
.ocbd-follow{position:absolute;inset:0;pointer-events:none;z-index:4;border-radius:inherit}
.ocbd-ftag{position:absolute;top:.5rem;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:.5rem;padding:.25rem .375rem .25rem .625rem;border-radius:.5rem;font-size:.75rem;font-weight:600;pointer-events:auto;white-space:nowrap}
.ocbd-ftag button{border:0;border-radius:.375rem;background:rgba(127,127,127,.25);color:inherit;font:inherit;font-size:.75rem;padding:.125rem .5rem;cursor:pointer}
.ocbd-ftag button:focus-visible{outline:2px solid #fff;outline-offset:1px}
`;
let injected = false;
export function ensurePresenceStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocbd-presence", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
