// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S8: shapes this app can't draw (approved prototype 8a/8b).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock } from "../index";
import { addShape, createBoard, getBoardMap, readShapes, type Shape } from "../model";
import { keptFields, unknownOf } from "./Placeholder";
import { Properties } from "./props/Properties";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const aws = { type: "rect", kind: "aws:stepfn-state", kindVersion: 3, x: 520, y: 120, w: 150, h: 56, text: "fraud-check", props: { stateType: "Task", retry: 3 } } as Omit<Shape, "id">;
const heat = { type: "acme:heatmap", x: 520, y: 112, w: 150, h: 72, text: "Risk heatmap", data: [1, 2, 3], palette: "viridis" } as unknown as Omit<Shape, "id">;

describe("unknownOf", () => {
  it("tells a missing library from an unknown type; bundled and core kinds are drawn as themselves", () => {
    expect(unknownOf({ id: "a", type: "rect" })).toBeNull();
    expect(unknownOf({ id: "a", type: "rect", kind: "uml:class" })).toBeNull();
    expect(unknownOf({ id: "a", ...aws })).toEqual({ what: "library", kind: "aws:stepfn-state", library: "AWS" });
    expect(unknownOf({ id: "a", ...heat })).toEqual({ what: "type", type: "acme:heatmap" });
  });
  it("lists the kept fields", () => {
    expect(keptFields({ id: "a", ...aws }, unknownOf({ id: "a", ...aws })!)).toEqual([["Kind", "aws:stepfn-state"], ["Version", "3"], ["stateType", "Task"], ["retry", "3"]]);
    expect(keptFields({ id: "a", ...heat }, unknownOf({ id: "a", ...heat })!)).toEqual([["Type", "acme:heatmap"], ["Fields kept", "2"], ["data", "3 items"], ["palette", "viridis"]]);
  });
});

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => act(() => root.unmount()));
  return { el, root };
}
const env: BlockEnv = { role: "edit", compact: false, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} };

describe("on the canvas", { timeout: 30_000 }, () => {
  it("draws an unknown type as a hatched placeholder and marks a missing library's shape", () => {
    const doc = new Y.Doc();
    const bid = createBoard(doc, "blank");
    const a = addShape(doc, bid, aws);
    const h = addShape(doc, bid, heat);
    const { el } = mount(<BoardBlock doc={doc} boardId={bid} env={env} />);
    const ph = el.querySelector(`[data-s="${h}"][data-unknown="type"]`)!;
    expect(ph).not.toBeNull();
    expect(ph.textContent).toContain("Risk heatmap");
    expect(ph.textContent).toContain("Unknown shape");
    expect(ph.querySelector("rect[stroke-dasharray]")!.getAttribute("fill")).toMatch(/^url\(#ocdg-hatch-/);
    expect(el.querySelector(`[data-mark="${a}"]`)).not.toBeNull();
    expect(el.querySelector(`[data-mark="${h}"]`)).toBeNull();
  });
});

describe("in the panel", { timeout: 30_000 }, () => {
  function panel(s: Omit<Shape, "id">) {
    const doc = new Y.Doc();
    const bid = createBoard(doc, "blank");
    const id = addShape(doc, bid, s);
    const get = () => readShapes(getBoardMap(doc, bid)!).find((x) => x.id === id)!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const r = () => act(() => root.render(<Properties doc={doc} boardId={bid} selected={[get()]} shapes={[get()]} edit />));
    r();
    doc.on("update", r);
    cleanups.push(() => act(() => root.unmount()));
    return { host, get };
  }
  it("explains a missing library, lists kept fields read only and copies the details", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { host } = panel(aws);
    expect(host.querySelector(".ocpp-kind")!.textContent).toBe("From a library you don’t have");
    expect(host.querySelector(".ocdg-unk")!.textContent).toContain("AWS library (aws:stepfn-state)");
    expect(host.querySelector(".ocdg-kept")!.textContent).toContain("stateTypeTask");
    expect(host.querySelector(".ocdg-kept input")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".ocdg-copy")!.click());
    await vi.waitFor(() => expect(host.querySelector(".ocdg-copy")!.textContent).toBe("Copied"));
    expect(JSON.parse((writeText.mock.calls[0] as unknown as [string])[0]).kind).toBe("aws:stepfn-state");
  });
  it("moving an unknown shape from the panel keeps every other field", () => {
    const { host, get } = panel(heat);
    expect(host.querySelector(".ocpp-kind")!.textContent).toBe("Unknown shape");
    const x = [...host.querySelectorAll<HTMLInputElement>("label")].find((l) => l.querySelector(".ocdg-lbl")!.textContent === "X")!.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(x, "600");
      x.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      x.focus();
      x.blur();
    });
    const s = get() as unknown as Record<string, unknown>;
    expect(s.x).toBe(600);
    expect([s.type, s.data, s.palette, s.text]).toEqual(["acme:heatmap", [1, 2, 3], "viridis", "Risk heatmap"]);
  });
});
