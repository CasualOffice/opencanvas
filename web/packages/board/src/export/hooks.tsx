// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The board's hooks into export (BRD-20): the lazily loaded dialog, Copy as PNG / SVG (⇧⌘C) and
// their board-menu entries. The context menu calls `copy` too.
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { ClipboardCopy, Download, FileCode2 } from "lucide-react";
import type { Shape } from "../model";
import { exportScope, type ExportScope } from "./scope";
import { quickCopy, quickDownload, type ExportFmt } from "./run";

const SW = 1.75;
const Dialog = lazy(() => import("./ExportBoardDialog"));

export interface BoardExport {
  /** Opens the dialog (the selection when there is one, or the given scope). */
  open: (scope?: ExportScope) => void;
  /** Copy as PNG / SVG: the selection, or the whole board. Falls back to a download, saying so. */
  copy: (fmt: ExportFmt) => Promise<void>;
  /** The dialog, when open; render it inside the board's root. */
  node: ReactNode;
}

export function useBoardExport(o: { doc: Y.Doc; shapes: Shape[]; sel: string[]; name?: string; toast: (m: string) => void; onClose?: () => void }): BoardExport {
  const [scope, setScope] = useState<ExportScope | null>(null);
  const cur = useRef(o);
  cur.current = o;
  const copy = async (fmt: ExportFmt) => {
    const { doc, shapes, sel, toast, name } = cur.current;
    const list = exportScope(shapes, sel.length ? "selection" : "board", sel);
    const what = sel.length ? "selection" : "board";
    try {
      if (await quickCopy(doc, list, fmt)) return toast(`Copied the ${what} as ${fmt.toUpperCase()}`);
      await quickDownload(doc, list, fmt, name);
      toast(`This browser can’t copy images, so the ${fmt.toUpperCase()} was downloaded instead`);
    } catch {
      toast(`Couldn't copy the ${what} as ${fmt.toUpperCase()}`);
    }
  };
  const node =
    scope !== null ? (
      <Suspense fallback={null}>
        <Dialog
          doc={o.doc}
          shapes={o.shapes}
          selection={o.sel}
          scope={scope}
          name={o.name}
          toast={o.toast}
          onClose={() => {
            setScope(null);
            o.onClose?.();
          }}
        />
      </Suspense>
    ) : null;
  return { open: (s) => setScope(s ?? (cur.current.sel.length ? "selection" : "board")), copy, node };
}

/** The board menu's entries: Export… (whiteboard only; diagram mode has its own) and Copy as PNG / SVG. */
export function ExportMenuItems({ x, dialog, close }: { x: BoardExport; dialog: boolean; close: () => void }) {
  return (
    <>
      {dialog ? (
        <button role="menuitem" className="ocbd-mi" onClick={() => (close(), x.open())}>
          <Download size={16} strokeWidth={SW} />
          Export…
        </button>
      ) : null}
      <button role="menuitem" className="ocbd-mi" aria-keyshortcuts="Shift+Meta+C Shift+Control+C" onClick={() => (close(), void x.copy("png"))}>
        <ClipboardCopy size={16} strokeWidth={SW} />
        Copy as PNG
        <kbd className="ocbd-kbd" aria-hidden="true">⇧⌘C</kbd>
      </button>
      <button role="menuitem" className="ocbd-mi" onClick={() => (close(), void x.copy("svg"))}>
        <FileCode2 size={16} strokeWidth={SW} />
        Copy as SVG
      </button>
    </>
  );
}
