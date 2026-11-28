// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Empty board (board UX prototype 9a, decision 11): hints for drawing, double-click to type and the
// shortcut sheet, three starter templates inserted in one Undo step; view-only people see only
// "This board is empty".
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "../index";
import { addShape, getBoardMap, readShapes } from "../model";
import { CONTAINER } from "../kinds";
import { TEMPLATES } from "./templates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (role: "edit" | "view" = "edit"): BlockEnv => ({ role, compact: false, me: { id: "p", name: "Priya", color: "#2a5ad7" }, users: [], toast: () => {} });
const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));

describe("templates", () => {
  it("are ordinary shapes and frames; members name their frame; connectors bind real shapes", () => {
    for (const t of TEMPLATES) {
      const list = t.build(0, 0);
      const ids = new Set(list.map((s) => s.id));
      for (const s of list) {
        const p = s.props?.parent;
        if (p) expect(ids.has(String(p))).toBe(true);
        if (s.start) expect(ids.has(s.start.shapeId)).toBe(true);
        if (s.end) expect(ids.has(s.end.shapeId)).toBe(true);
      }
    }
    expect(TEMPLATES.map((t) => t.name)).toEqual(["Retrospective", "Flowchart", "Brainstorm"]);
    expect(TEMPLATES[0]!.build(0, 0).filter((s) => s.kind === CONTAINER).map((s) => s.label)).toEqual(["Went well", "To improve", "Actions"]);
  });
});

describe("empty board", { timeout: 60_000 }, () => {
  it("editors see hints and starters; a starter is one Undo step; the hints go with the first shape", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const empty = el.querySelector(".ocbd-empty")!;
    expect(empty.querySelector("h3")?.textContent).toBe("Start your board");
    expect(empty.textContent).toContain("double-click anywhere to type");
    expect(empty.textContent).toContain("sticky note");
    expect(empty.textContent).toContain("all shortcuts");
    const group = empty.querySelector('[role="group"][aria-label="Start from a template"]')!;
    const names = [...group.querySelectorAll("button")].map((b) => b.textContent);
    expect(names).toEqual(["Retrospective", "Flowchart", "Brainstorm"]);
    act(() => group.querySelector<HTMLButtonElement>("button")!.click());
    const added = shapes(doc, id);
    expect(added.filter((s) => s.kind === CONTAINER)).toHaveLength(3);
    expect(added.length).toBeGreaterThan(3);
    expect(el.querySelector(".ocbd-empty")).toBeNull();
    // One Undo takes the whole template away, and the empty state comes back.
    key(el.querySelector(".ocbd")!, "z", { ctrlKey: true });
    expect(shapes(doc, id)).toHaveLength(0);
    expect(el.querySelector(".ocbd-empty h3")).toBeTruthy();
    act(() => void addShape(doc, id, { type: "rect", x: 0, y: 0, w: 10, h: 10 }));
    expect(el.querySelector(".ocbd-empty")).toBeNull();
  });

  it("view-only people see only 'This board is empty'", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env("view")} />);
    const empty = el.querySelector(".ocbd-empty")!;
    expect(empty.textContent).toBe("This board is empty");
    expect(empty.querySelector("button")).toBeNull();
  });
});
