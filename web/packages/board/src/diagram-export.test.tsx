// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14.6 S7 (approved frames 7f, 7g): the export dialog from the board options menu in diagram
// mode, the server's "what changes" report, the Mermaid preview, and the Import entry.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv, DiagramExportReport } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape } from "./model";
import { selectionShapes } from "./diagram/export/ExportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const until = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {});
    check();
  }, { timeout: 10_000 });
const btn = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name) as HTMLElement | undefined;
const shell = () => document.querySelector<HTMLElement>(".ocdg")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="ocdg-ex-t"]');
const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === name);

const REPORT: DiagramExportReport = {
  format: "mermaid",
  counts: { shapes: 2, connectors: 1, containers: 0, needLook: 0 },
  items: [
    { level: "gray", code: "positions", title: "Positions and sizes are not kept", detail: "Mermaid lays the diagram out itself.", count: 1, examples: [] },
    { level: "ok", code: "labels", title: "Connector labels are kept", count: 1, examples: [] },
  ],
};

function env(extra: Partial<BlockEnv> = {}): BlockEnv {
  return { role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {}, ...extra };
}
function fixture() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "Gateway" });
  const b = addShape(doc, id, { type: "rect", x: 220, y: 20, w: 100, h: 60, text: "Orders" });
  addShape(doc, id, { type: "arrow", pts: [[120, 50], [220, 50]], start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" } });
  return { doc, id, a, b };
}
async function openMenu(e: BlockEnv) {
  const { doc, id } = fixture();
  const el = mount(<BoardBlock doc={doc} boardId={id} env={e} />);
  act(() => btn(el, "Diagram")!.click());
  await until(() => expect(document.querySelector(".ocdg")).toBeTruthy());
  act(() => btn(shell(), "Board options")!.click());
  return { doc, id };
}

describe("diagram export and import entries (DGM-14.6, S7)", { timeout: 30_000 }, () => {
  it("Export… opens the dialog; draw.io and Mermaid show the server's report; Mermaid previews the text", async () => {
    const exportBoard = vi.fn(async (_b: string, f: "drawio" | "mmd") => ({ text: f === "mmd" ? "flowchart TB\n    a[\"Gateway\"]\n" : "<mxfile/>", report: { ...REPORT, format: f === "mmd" ? ("mermaid" as const) : ("drawio" as const) } }));
    const { id } = await openMenu(env({ exportBoard }));
    act(() => item("Export…")!.click());
    await until(() => expect(dialog()).toBeTruthy());
    const fmts = [...dialog()!.querySelectorAll('[aria-label="Format"] [role="radio"]')].map((b) => b.querySelector(".ocdg-fn")!.textContent);
    expect(fmts).toEqual(["PNG", "SVG", "draw.io", "Mermaid"]);
    // draw.io first (with a server), whole diagram.
    await until(() => expect(exportBoard).toHaveBeenCalledWith(id, "drawio", null));
    await until(() => expect(dialog()!.querySelector('[data-code="positions"]')).toBeTruthy());
    expect(btn(dialog()!, "Export .drawio")!.hasAttribute("disabled")).toBe(false);
    // Selection needs a selection.
    expect(btn(dialog()!, "Selection")!.hasAttribute("disabled")).toBe(true);
    act(() => [...dialog()!.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent?.includes("Mermaid"))!.click());
    await until(() => expect(document.querySelector('[data-testid="mermaid-preview"]')?.textContent).toContain("flowchart TB"));
    expect(dialog()!.textContent).toContain("What changes in Mermaid");
    expect(btn(dialog()!, "Download .mmd")).toBeTruthy();
    expect(btn(dialog()!, "Copy text")).toBeTruthy();
    // PNG: the browser export, with its own short report; nothing asked of the server.
    const calls = exportBoard.mock.calls.length;
    act(() => [...dialog()!.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent?.includes("PNG"))!.click());
    expect(dialog()!.querySelector('[data-code="picture"]')).toBeTruthy();
    expect(exportBoard.mock.calls.length).toBe(calls);
    // Esc closes the dialog and stays in diagram mode.
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await until(() => expect(dialog()).toBeNull());
    expect(document.querySelector(".ocdg")).toBeTruthy();
  });

  it("without a server draw.io and Mermaid are not offered", async () => {
    await openMenu(env());
    act(() => item("Export…")!.click());
    await until(() => expect(dialog()).toBeTruthy());
    const radio = (n: string) => [...dialog()!.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent?.includes(n))!;
    expect(radio("draw.io").hasAttribute("disabled")).toBe(true);
    expect(radio("Mermaid").textContent).toContain("Needs the canvas server");
    expect(radio("PNG").getAttribute("aria-checked")).toBe("true");
  });

  it("Import… adds to the open board through the host's import dialog", async () => {
    const importToBoard = vi.fn();
    const { id } = await openMenu(env({ importToBoard }));
    act(() => item("Import…")!.click());
    expect(importToBoard).toHaveBeenCalledWith(id);
    // Not offered without the entry (no diagram import formats) or for view-only people.
    cleanups.forEach((c) => c());
    cleanups = [];
    document.body.innerHTML = "";
    await openMenu(env());
    expect(item("Import…")).toBeUndefined();
    expect(item("Export…")).toBeTruthy();
  });

  it("a selection exports its shapes and the connectors between them", () => {
    const s = [
      { id: "a", type: "rect" as const },
      { id: "b", type: "rect" as const },
      { id: "c", type: "rect" as const },
      { id: "ab", type: "arrow" as const, start: { shapeId: "a", anchor: "center" as const }, end: { shapeId: "b", anchor: "center" as const } },
      { id: "ac", type: "arrow" as const, start: { shapeId: "a", anchor: "center" as const }, end: { shapeId: "c", anchor: "center" as const } },
    ];
    expect(selectionShapes(s, ["a", "b"]).map((x) => x.id)).toEqual(["a", "b", "ab"]);
  });
});
