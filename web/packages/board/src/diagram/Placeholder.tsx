// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shapes this app can't draw (DGM-14 S8, prototype 8a/8b; ADR-045 §3-5).
// - A kind whose library is missing: drawn as its base type (the normal renderer) plus a small
//   plugin marker on the corner (`KindMarks`).
// - A `type` this app doesn't know: a hatched, dashed placeholder box with a puzzle icon, its own
//   text if it has any, and "Unknown shape" (`UnknownShape`).
// In both cases the box can be moved, resized, connected and deleted; every other field is kept as
// it is (writers set only the keys they change). The panel explains it and lists the kept fields
// read only, with Copy details for a support question.
import { memo, useState } from "react";
import { Check, Copy, Puzzle } from "lucide-react";
import { descriptorOf, LEGACY_TYPES } from "../registry";
import type { Shape } from "../model";

const SW = 1.75;

/** Namespaces of the libraries that ship with the diagram (drawn by them, not "missing"). */
export const BUNDLED = new Set(["core", "diagram", "uml", "erd", "net", "flow", "bpmn", "general"]);

export type Unknown = { what: "library"; kind: string; library: string } | { what: "type"; type: string };

/** Why a shape can't be drawn as itself, or null when it can. */
export function unknownOf(s: Shape): Unknown | null {
  if (!LEGACY_TYPES.includes(s.type)) return { what: "type", type: typeof s.type === "string" && s.type ? s.type : "unknown" };
  const d = descriptorOf(s);
  if (!d.missing || !s.kind) return null;
  const ns = s.kind.split(":")[0]!;
  if (BUNDLED.has(ns)) return null;
  return { what: "library", kind: s.kind, library: ns.length <= 3 ? ns.toUpperCase() : ns[0]!.toUpperCase() + ns.slice(1) };
}

/** The placeholder for an unknown `type` (8b). Stands in for ShapeView's drawing. */
export const UnknownShape = memo(function UnknownShape({ s }: { s: Shape }) {
  const x = s.x ?? 0, y = s.y ?? 0, w = Math.max(40, s.w ?? 150), h = Math.max(32, s.h ?? 72);
  const pid = `ocdg-hatch-${s.id}`;
  const text = typeof s.text === "string" ? s.text.split("\n")[0] : "";
  return (
    <g data-s={s.id} data-unknown="type" style={{ cursor: "move" }}>
      <defs>
        <pattern id={pid} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="var(--line-2)" strokeWidth="3" />
        </pattern>
      </defs>
      <rect x={x} y={y} width={w} height={h} rx={6} fill="var(--app)" />
      <rect x={x} y={y} width={w} height={h} rx={6} fill={`url(#${pid})`} stroke="var(--fg-2)" strokeDasharray="5 4" strokeWidth={1.25} />
      <Puzzle x={x + 8} y={y + 8} width={14} height={14} color="var(--fg-2)" strokeWidth={SW} aria-hidden="true" />
      {text ? (
        <text x={x + w / 2} y={y + h / 2 - 2} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--fg)">{text}</text>
      ) : null}
      <text x={x + w / 2} y={y + h / 2 + (text ? 14 : 4)} textAnchor="middle" fontSize={11} fill="var(--fg-2)">Unknown shape</text>
    </g>
  );
});

/** Plugin markers on shapes whose library is missing (8a), drawn over the normal renderer. */
export const KindMarks = memo(function KindMarks({ shapes }: { shapes: Shape[] }) {
  const marks = shapes.filter((s) => unknownOf(s)?.what === "library");
  if (!marks.length) return null;
  return (
    <g pointerEvents="none" data-kind-marks="">
      {marks.map((s) => {
        const x = (s.x ?? 0) + (s.w ?? 0), y = s.y ?? 0;
        return (
          <g key={s.id} data-mark={s.id}>
            <circle cx={x} cy={y} r={9} fill="var(--app)" stroke="var(--line-2)" />
            <Puzzle x={x - 6} y={y - 6} width={12} height={12} color="var(--fg-2)" strokeWidth={SW} aria-hidden="true" />
          </g>
        );
      })}
    </g>
  );
});

const GEOMETRY = new Set(["id", "type", "x", "y", "w", "h", "text", "kind", "kindVersion", "props", "group"]);

/** Short read-only display of a kept value. */
export function brief(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `${v.length.toLocaleString("en-US")} ${v.length === 1 ? "item" : "items"}`;
  const j = JSON.stringify(v);
  return j.length > 60 ? j.slice(0, 57) + "…" : j;
}

/** The kept fields, in the panel's order. */
export function keptFields(s: Shape, u: Unknown): [string, string][] {
  const props = s.props && typeof s.props === "object" ? Object.entries(s.props) : [];
  if (u.what === "library") {
    return [["Kind", u.kind], ...(s.kindVersion != null ? [["Version", String(s.kindVersion)] as [string, string]] : []), ...props.map(([k, v]) => [k, brief(v)] as [string, string])];
  }
  const rest = Object.entries(s as unknown as Record<string, unknown>).filter(([k]) => !GEOMETRY.has(k));
  const all = [...rest, ...props];
  return [["Type", u.type], ["Fields kept", String(all.length)], ...all.map(([k, v]) => [k, brief(v)] as [string, string])];
}

/** Notice and kept fields for the properties panel (8a/8b). */
export function PlaceholderPanel({ s, u }: { s: Shape; u: Unknown }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(s, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard refused: nothing to do, the fields are on screen */
    }
  };
  return (
    <>
      <p className="ocdg-unk">
        {u.what === "library" ? (
          <>
            This shape comes from the {u.library} library (<code>{u.kind}</code>), which isn’t installed here, so it is drawn as a plain box. You can move, resize, rename and connect it. Its other settings are kept for people who have the library.
          </>
        ) : (
          <>
            This app can’t draw this shape. It was made with a newer OpenCanvas or a plugin this app doesn’t know (<code>{u.type}</code>). You can move and resize its box, connect to it and delete it. Everything else about it is kept exactly as it is.
          </>
        )}
      </p>
      <section className="ocdg-sec" aria-labelledby="ocdg-s-kept">
        <h3 className="ocdg-sh" id="ocdg-s-kept">
          Kept as it is <span className="ocdg-ro">read only</span>
        </h3>
        <dl className="ocdg-kept">
          {keptFields(s, u).map(([k, v], i) => (
            <div key={k + i}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="ocdg-bb ocdg-copy" onClick={() => void copy()}>
          {copied ? <Check size={14} strokeWidth={SW} aria-hidden="true" /> : <Copy size={14} strokeWidth={SW} aria-hidden="true" />}
          {copied ? "Copied" : "Copy details"}
        </button>
      </section>
    </>
  );
}

export const PLACEHOLDER_CSS = `
.ocdg-unk{margin:0 1rem .5rem;padding:.625rem .75rem;border-radius:.5rem;background:var(--sunk);font-size:.8125rem;color:var(--fg)}
.ocdg-unk code{font-size:.75rem}
.ocdg-ro{margin-left:.375rem;font-weight:500;text-transform:none;letter-spacing:0;color:var(--fg-2)}
.ocdg-kept{margin:0 0 .625rem;font-size:.8125rem}
.ocdg-kept div{display:flex;justify-content:space-between;gap:.75rem;padding:.25rem 0;border-bottom:1px solid var(--line)}
.ocdg-kept dt{color:var(--fg-2)}
.ocdg-kept dd{margin:0;text-align:right;overflow-wrap:anywhere;font-family:var(--mono,ui-monospace,monospace);font-size:.75rem}
.ocdg-copy{display:inline-flex;align-items:center;gap:.375rem}
`;
