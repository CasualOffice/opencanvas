// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-05: the incremental projection and arrow resolver must not change what is drawn. A board
// kept up to date through many local and remote edits renders the same markup as a board
// mounted fresh on the same state (which reads every shape once, like `readShapes`).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock } from "./index";
import { addShape, bringToFront, deleteShape, getBoardMap, moveShapes, readShapes, updateShape } from "./model";
import { syncBoundArrows } from "./connectors";
import { makeFixture, rng } from "../bench/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env: BlockEnv = { role: "edit", compact: false, me: { id: "u", name: "U", color: "#2a5ad7" }, users: [], toast: () => {} };

async function mount(doc: Y.Doc, boardId: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<BoardBlock doc={doc} boardId={boardId} env={env} />));
  return { host, root };
}

/** The board's SVG with per-instance ids (useId) normalised. */
const markup = (host: HTMLElement) => {
  const svg = host.querySelector("svg.ocbd-svg") ?? host.querySelector("svg");
  return (svg?.outerHTML ?? "").replace(/ocbd-(ah|dots)-[^"#)\s]+/g, "ocbd-$1-X").replace(/-c-/g, "-c-");
};

describe("incremental board rendering", () => {
  it("draws the same as a fresh mount after local and remote edits", async () => {
    const fx = makeFixture({ nodes: 120, seed: 21 });
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(fx.doc));
    peer.on("update", (u: Uint8Array) => Y.applyUpdate(fx.doc, u, "remote"));
    fx.doc.on("update", (u: Uint8Array, o: unknown) => o !== "remote" && Y.applyUpdate(peer, u, "remote"));
    const live = await mount(fx.doc, fx.boardId);
    const r = rng(3);
    for (let i = 0; i < 80; i++) {
      const d = r() < 0.5 ? fx.doc : peer;
      const ids = readShapes(getBoardMap(d, fx.boardId)!).map((s) => s.id);
      const id = ids[Math.floor(r() * ids.length)];
      await act(async () => {
        const op = i % 6;
        if (op === 0) moveShapes(d, fx.boardId, [{ id, patch: { x: Math.round(r() * 2000), y: Math.round(r() * 2000) } }]);
        else if (op === 1) updateShape(d, fx.boardId, id, { text: "edit " + i });
        else if (op === 2) bringToFront(d, fx.boardId, id);
        else if (op === 3) addShape(d, fx.boardId, { type: "arrow", pts: [[0, 0], [10, 10]], start: { shapeId: ids[0], anchor: "center" }, end: { shapeId: id, anchor: "left" }, route: i % 2 ? "elbow" : undefined });
        else if (op === 4) deleteShape(d, fx.boardId, id);
        else syncBoundArrows(d, fx.boardId);
      });
    }
    const fresh = await mount(fx.doc, fx.boardId);
    const a = markup(live.host), b = markup(fresh.host);
    expect(a.length).toBeGreaterThan(10000);
    expect(a).toBe(b);
    await act(async () => {
      live.root.unmount();
      fresh.root.unmount();
    });
  });
});
