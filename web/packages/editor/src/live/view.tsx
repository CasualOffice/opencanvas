// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// First-bundle placeholders for the live block node views: a header-shaped skeleton (so the page
// does not jump, frame 5a) until `LiveView.tsx` loads.
import { lazy, Suspense } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

const LiveBlockView = lazy(() => import("./LiveView").then((m) => ({ default: m.LiveBlockView })));
const BlockRefView = lazy(() => import("./LiveView").then((m) => ({ default: m.BlockRefView })));

function Skeleton({ kind, title }: { kind: "live" | "ref"; title: string }) {
  return (
    <NodeViewWrapper className={kind === "live" ? "lb" : "rf"} aria-busy="true">
      <div className={kind === "live" ? "lb-h" : "rf-h"} contentEditable={false}>
        <span className={kind === "live" ? "lb-live" : "rf-k"}>{kind === "live" ? "Live" : "Reference"}</span>
        <span className="lb-t">{title}</span>
      </div>
      <div className="lb-b" contentEditable={false} style={{ minHeight: "3rem" }} />
    </NodeViewWrapper>
  );
}

export function LiveStub(p: ReactNodeViewProps) {
  return (
    <Suspense fallback={<Skeleton kind="live" title={String(p.node.attrs.title ?? "")} />}>
      <LiveBlockView {...p} />
    </Suspense>
  );
}

export function RefStub(p: ReactNodeViewProps) {
  return (
    <Suspense fallback={<Skeleton kind="ref" title={String(p.node.attrs.title ?? "")} />}>
      <BlockRefView {...p} />
    </Suspense>
  );
}
