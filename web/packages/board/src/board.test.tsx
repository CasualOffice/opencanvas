// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { BlockEnv, Role } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, BOARD_PRESETS, deleteShape, getBoardMap, readShapes, updateShape } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const env = (role: Role = "edit", compact = false): BlockEnv => ({
  role,
  compact,
  me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" },
  users: [],
  toast: () => {},
});

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array, o: unknown) => o !== "remote" && Y.applyUpdate(b, u, "remote"));
  b.on("update", (u: Uint8Array, o: unknown) => o !== "remote" && Y.applyUpdate(a, u, "remote"));
  return [a, b] as const;
}

describe("createBoard presets", () => {
  it.each(BOARD_PRESETS)("%s", (p) => {
    const doc = new Y.Doc();
    const id = createBoard(doc, p);
    const m = getBoardMap(doc, id)!;
    expect(m.get("shapes")).toBeInstanceOf(Y.Map);
    expect(m.get("order")).toBeInstanceOf(Y.Array);
    const list = shapes(doc, id);
    expect((m.get("order") as Y.Array<string>).length).toBe(list.length);
    if (p === "blank") expect(list).toHaveLength(0);
    else expect(list.length).toBeGreaterThan(3);
    for (const s of list) {
      if (s.type === "arrow" || s.type === "pen") expect(s.pts!.length).toBeGreaterThanOrEqual(2);
      else {
        expect(typeof s.x).toBe("number");
        expect(typeof s.y).toBe("number");
      }
    }
  });
  it("flow preset matches the prototype", () => {
    const doc = new Y.Doc();
    const list = shapes(doc, createBoard(doc, "flow"));
    expect(list.map((s) => s.type)).toEqual(["rect", "sticky", "arrow", "sticky", "arrow", "sticky", "arrow", "text"]);
    expect(list[0].label).toBe("Host app");
    expect(list[5].text).toBe("Autosave →\nPUT /files/:id");
  });
});

describe("board collaboration", () => {
  it("two docs converge on a shape move", () => {
    const [a, b] = pair();
    const id = createBoard(a, "brainstorm");
    const sid = shapes(b, id).find((s) => s.type === "sticky")!.id;
    updateShape(b, id, sid, { x: 400, y: 321 });
    const sa = shapes(a, id).find((s) => s.id === sid)!;
    expect([sa.x, sa.y]).toEqual([400, 321]);
    expect(shapes(a, id)).toEqual(shapes(b, id));
  });

  it("concurrent move + delete + add converge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const id = createBoard(a, "flow");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const [s0, s1] = shapes(a, id);
    updateShape(a, id, s0.id, { x: 1 });
    updateShape(b, id, s0.id, { x: 2 });
    deleteShape(a, id, s1.id);
    updateShape(b, id, s1.id, { text: "edited while deleted" });
    addShape(a, id, { type: "sticky", x: 0, y: 0, w: 150, h: 110, fill: "y", text: "A" });
    addShape(b, id, { type: "rect", x: 0, y: 0, w: 10, h: 10 });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(shapes(a, id)).toEqual(shapes(b, id));
    expect(shapes(a, id).some((s) => s.id === s1.id)).toBe(false);
    expect(shapes(a, id)).toHaveLength(9);
  });
});

// Heavy suite (full board mounts in jsdom): an explicit timeout for slow CI runners.
describe("BoardBlock render", { timeout: 60_000 }, () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.body.innerHTML = "";
  });
  const mount = (node: React.ReactNode) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(node));
    cleanup = () => act(() => root.unmount());
    return el;
  };

  it.each(BOARD_PRESETS)("renders %s", (p) => {
    const doc = new Y.Doc();
    const id = createBoard(doc, p);
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    expect(el.querySelectorAll("[data-s]").length).toBe(shapes(doc, id).length);
    expect(el.querySelectorAll(".ocbd-tool [data-tool]")).toHaveLength(10);
    expect(document.head.querySelector("style[data-ocbd]")).toBeTruthy();
  });

  it("re-renders on remote changes", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    expect(el.querySelectorAll("[data-s]")).toHaveLength(0);
    act(() => void addShape(doc, id, { type: "sticky", x: 10, y: 10, w: 150, h: 110, fill: "g", text: "remote" }));
    expect(el.querySelectorAll("[data-s]")).toHaveLength(1);
    expect(el.textContent).toContain("remote");
  });

  it("viewers only get select and hand", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "flow");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env("view")} />);
    const labels = [...el.querySelectorAll(".ocbd-tool [data-tool]")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Select", "Pan"]);
  });

  it("shows the tap-to-open cover in compact mode", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "flow");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env("edit", true)} />);
    const cover = el.querySelector<HTMLButtonElement>(".ocbd-cover");
    expect(cover?.textContent).toContain("Tap to open board");
    act(() => cover!.click());
    expect(document.querySelector(".ocbd.ocbd-full")).toBeTruthy();
  });

  it("renders remote pointers from awareness", () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "flow");
    const remoteDoc = new Y.Doc();
    const local = new Awareness(doc);
    const remote = new Awareness(remoteDoc);
    remote.setLocalState({ user: { id: "ravi", name: "Ravi Menon", color: "#e5602a" }, board: { id, x: 100, y: 80 } });
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} awareness={local} />);
    act(() => {
      applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), "remote");
    });
    expect(el.textContent).toContain("Ravi Menon");
    local.destroy();
    remote.destroy();
  });
});
