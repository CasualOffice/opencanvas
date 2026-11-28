// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Frames in the zoom menu (BRD-21, prototype 5c): each frame zooms to it; Present (⇧P) at the end.
import { Frame, Presentation } from "lucide-react";

const SW = 1.75;

export function FrameItems({ frames, onFrame, onPresent, close }: { frames?: { id: string; name: string }[]; onFrame?: (id: string) => void; onPresent?: () => void; close: (refocus?: boolean) => void }) {
  if (!frames?.length) return null;
  return (
    <>
      <span className="ocbd-msep" />
      <span className="ocbd-mh" role="presentation">Frames</span>
      {frames.map((f) => (
        <button key={f.id} role="menuitem" tabIndex={-1} className="ocbd-mi" onClick={() => (onFrame?.(f.id), close())}>
          <Frame size={16} strokeWidth={SW} />
          {f.name}
        </button>
      ))}
      {onPresent ? (
        <button role="menuitem" tabIndex={-1} className="ocbd-mi" aria-keyshortcuts="Shift+P" onClick={() => (close(false), onPresent())}>
          <Presentation size={16} strokeWidth={SW} />
          Present
          <kbd className="ocbd-kbd" aria-hidden="true">⇧P</kbd>
        </button>
      ) : null}
    </>
  );
}
