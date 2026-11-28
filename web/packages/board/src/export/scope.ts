// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// What an export draws (BRD-20, decision 7): the whole board, the selection, or one frame.
import type { Shape } from "../model";

/** `board`, `selection`, or `f:<frame id>`. */
export type ExportScope = "board" | "selection" | `f:${string}`;

const parentOf = (s: Shape) => (typeof s.props?.parent === "string" ? (s.props.parent as string) : null);

/** The ids in `roots` and every shape that names one of them (or one of those) as `props.parent`. */
export function withMembers(all: Shape[], roots: Iterable<string>): Set<string> {
  const out = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of all) {
      const p = parentOf(s);
      if (p && out.has(p) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/** The shapes of a scope, in board order: picked shapes, their frames' members, the connectors between them. */
export function exportScope(all: Shape[], scope: ExportScope, sel: string[]): Shape[] {
  if (scope === "board") return all;
  const roots = scope === "selection" ? sel : [scope.slice(2)];
  const picked = withMembers(
    all,
    roots.filter((id) => all.some((s) => s.id === id && s.type !== "arrow")),
  );
  const chosen = new Set(scope === "selection" ? sel : []);
  return all.filter((s) => picked.has(s.id) || (s.type === "arrow" && (chosen.has(s.id) || (!!s.start?.shapeId && !!s.end?.shapeId && picked.has(s.start.shapeId) && picked.has(s.end.shapeId)))));
}
