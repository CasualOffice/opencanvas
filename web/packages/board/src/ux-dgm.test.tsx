// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// UX-DGM-01: issues found using the board and the diagram window as a person would (audit 2026-11-24).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });

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
  return el;
}
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const until = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {});
    check();
  }, { timeout: 5_000 });
const shell = () => document.querySelector<HTMLElement>(".ocdg");

function board() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  addShape(doc, id, { type: "rect", x: 20, y: 40, w: 120, h: 60, text: "Load balancer" });
  addShape(doc, id, { type: "rect", x: 300, y: 40, w: 120, h: 60, text: "Payments service" });
  return { doc, id };
}
async function openDiagram() {
  const f = board();
  const el = mount(<BoardBlock doc={f.doc} boardId={f.id} env={env()} />);
  act(() => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Diagram")!.click());
  await until(() => expect(shell()).toBeTruthy());
  return f;
}

describe("diagram window", { timeout: 30_000 }, () => {
  // Must run first: the styles are injected once per page.
  it("the Commands button in the top bar is styled from the start, not only after ⌘K was used once", async () => {
    await openDiagram();
    expect(shell()!.querySelector(".ocdg-cmdk")).toBeTruthy();
    const css = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css).toContain(".ocdg-cmdk{");
  });
});
