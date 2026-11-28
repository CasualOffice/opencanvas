// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The board's hooks into frames (BRD-21): rename, Present (lazy), the names layer.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import type { Shape } from "../model";
import { framesOf } from "./model";
import { renameFrame } from "./ops";
import { FrameRename } from "./view";

const Present = lazy(() => import("./Present"));

export function useFrames(o: { doc: Y.Doc; boardId: string; shapes: Shape[]; view: { tx: number; ty: number; z: number }; origin: unknown; edit: boolean; onSay: (m: string) => void; onDone: () => void }) {
  const frames = useMemo(() => framesOf(o.shapes), [o.shapes]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [presenting, setPresenting] = useState<string | null>(null);
  const target = renaming ? frames.find((f) => f.id === renaming) : undefined;
  // BRD-33: focus goes back to the board once the presentation is gone (while it is on screen the
  // board cannot take focus, so doing it in onClose left the focus on the page).
  const wasPresenting = useRef(false);
  const onDone = useRef(o.onDone);
  onDone.current = o.onDone;
  useEffect(() => {
    if (presenting === null && wasPresenting.current) onDone.current();
    wasPresenting.current = presenting !== null;
  }, [presenting]);
  const nodes: ReactNode[] = [];
  if (target)
    nodes.push(
      <FrameRename
        key="rename"
        frame={target}
        view={o.view}
        onDone={(name) => {
          setRenaming(null);
          if (name !== null && name.trim()) {
            renameFrame(o.doc, o.boardId, target.id, name, o.origin);
            o.onSay(`Frame renamed to ${name.trim()}`);
          }
          o.onDone();
        }}
      />,
    );
  if (presenting !== null)
    nodes.push(
      <Suspense key="present" fallback={null}>
        <Present
          doc={o.doc}
          shapes={o.shapes}
          start={presenting || undefined}
          onClose={() => {
            setPresenting(null);
          }}
        />
      </Suspense>,
    );
  return {
    frames,
    rename: o.edit ? (id: string) => setRenaming(id) : undefined,
    /** Starts presenting (from the given frame); false when the board has no frames. */
    present: (from?: string) => {
      if (!frames.length) return false;
      setPresenting(from ?? "");
      return true;
    },
    node: nodes,
  };
}
