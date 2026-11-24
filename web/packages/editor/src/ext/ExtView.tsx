// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Node view of an SDK block (BSDK-03). Small on purpose: the chrome, the sandbox runtime and the
// schema checks load lazily (Chrome.tsx) the first time a canvas shows an SDK block. Until then
// the block keeps its place with the loading skeleton at its last known height. Children
// (`content: "blocks"` or `"inline"`) sit below the frame, full width, inside the block's own
// outline (the open point "children layout", settled: one column, the block first).
import { lazy, Suspense } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import type { ExtAttrs } from "./model";

const Chrome = lazy(() => import("./Chrome"));

export function Skeleton({ height }: { height?: number | null }) {
  const h = Math.max(48, Math.min(1200, Number(height) || 0));
  return (
    <div className="oc-ext-frame oc-ext-loading" aria-busy="true" style={height ? { height: h } : undefined}>
      <div className="oc-ext-sk" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function ExtView(p: ReactNodeViewProps) {
  const a = p.node.attrs as ExtAttrs;
  return (
    <NodeViewWrapper className="oc-ext" data-ext-type={a.type} data-ext-block={a.blockId ?? undefined}>
      <Suspense fallback={<Skeleton height={a.fallback?.height} />}>
        <Chrome {...p} />
      </Suspense>
      <NodeViewContent className="oc-ext-children" />
    </NodeViewWrapper>
  );
}
