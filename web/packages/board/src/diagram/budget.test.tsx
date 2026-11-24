// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S9: the size budget (approved prototype 9a-9c).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addShape, createBoard, type Shape } from "../model";
import { BOARD_SHARE, DEFAULT_MAX_DOC_BYTES, levelOf, mb, measureBoard } from "./Budget";
import Shell from "./Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("budget helpers", () => {
  it("levels at 80 % and over 100 %", () => {
    expect(levelOf(79, 100)).toBe("ok");
    expect(levelOf(80, 100)).toBe("warn");
    expect(levelOf(100, 100)).toBe("warn");
    expect(levelOf(101, 100)).toBe("over");
    expect(DEFAULT_MAX_DOC_BYTES * BOARD_SHARE).toBe(5 * 1024 * 1024);
    expect(mb(4.3 * 1024 * 1024)).toBe("4.3 MB");
    expect(mb(5 * 1024 * 1024)).toBe("5 MB");
  });
  it("a small diagram reads in KB, not '0 MB' (UX-DGM-01)", () => {
    expect(mb(0)).toBe("0 KB");
    expect(mb(300)).toBe("1 KB");
    expect(mb(12.4 * 1024)).toBe("12 KB");
    expect(mb(1023 * 1024)).toBe("1023 KB");
    expect(mb(1024 * 1024)).toBe("1 MB");
  });
  it("measures a board's encoded size, by part, with the largest container and image", () => {
    const doc = new Y.Doc();
    const bid = createBoard(doc, "blank");
    const other = createBoard(doc, "blank");
    addShape(doc, other, { type: "text", x: 0, y: 0, text: "x".repeat(20000) });
    addShape(doc, bid, { type: "rect", x: 0, y: 0, w: 1000, h: 1000, label: "DC-1 (old)" });
    for (let i = 0; i < 20; i++) addShape(doc, bid, { type: "rect", x: 10 + i, y: 10, w: 20, h: 20, text: "node " + i });
    addShape(doc, bid, { type: "image", x: 2000, y: 0, w: 10, h: 10, src: "data:image/png;base64," + "A".repeat(5000), alt: "rack-photo.jpg" });
    addShape(doc, bid, { type: "arrow", pts: [[0, 0], [5, 5]] });
    const u = measureBoard(doc, bid);
    expect(u.shapes).toBe(22);
    expect(u.connectors).toBe(1);
    expect(u.images).toBe(1);
    // The board alone: the other board's 20 kB of text isn't counted; the document's size is.
    expect(u.bytes).toBeGreaterThan(5000);
    expect(u.bytes).toBeLessThan(15000);
    expect(u.docBytes).toBeGreaterThan(u.bytes + 20000);
    const sum = u.parts.shapes + u.parts.connectors + u.parts.text + u.parts.images;
    expect(Math.abs(sum - u.bytes)).toBeLessThan(5);
    expect(u.parts.images).toBeGreaterThan(u.parts.shapes);
    expect(u.largest.map((x) => [x.label, x.what, x.count])).toEqual([
      ["rack-photo.jpg", "image", 1],
      ["Container “DC-1 (old)”", "container", 20],
    ]);
  });
});

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
});
const env = { role: "edit" as const, compact: false, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} };
const prefs = { grid: true, gridSize: 20, rulers: true, snapGrid: true, snapShapes: true, connector: "elbow" as const };

function mountShell(doc: Y.Doc, bid: string, maxDocBytes: number, select = vi.fn()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <Shell doc={doc} boardId={bid} env={env} anchor={() => null} place={{ heading: "", title: "" }} closing={false} onClosed={() => {}} onBack={() => {}} peers={[]} undo={{ can: false, run: () => {} }} redo={{ can: false, run: () => {} }} menuOpen={false} onMenu={() => {}} origin={null} prefs={prefs} onPrefs={() => {}} maxDocBytes={maxDocBytes} canvas={{ shapes: [], sel: [], select }}>
        <div />
      </Shell>,
    ),
  );
  cleanups.push(() => act(() => root.unmount()));
  return host;
}

function boardOf(bytes: number) {
  const doc = new Y.Doc();
  const bid = createBoard(doc, "blank");
  const s: Omit<Shape, "id"> = { type: "rect", x: 0, y: 0, w: 900, h: 900, label: "Big" };
  addShape(doc, bid, s);
  addShape(doc, bid, { type: "text", x: 10, y: 10, text: "x".repeat(bytes) });
  return { doc, bid, size: measureBoard(doc, bid).bytes };
}

describe("size budget in the diagram", { timeout: 30_000 }, () => {
  it("shows nothing below 80 %", () => {
    const { doc, bid, size } = boardOf(1000);
    const host = mountShell(doc, bid, Math.ceil((size / 0.5) / BOARD_SHARE));
    expect(host.querySelector(".ocdg-ban")).toBeNull();
    expect(host.querySelector(".ocdg-chip")).toBeNull();
    expect(host.querySelector('[role="meter"]')!.getAttribute("aria-valuetext")).toMatch(/50%$/);
  });
  it("amber from 80 %: a dismissible banner and a chip", () => {
    const { doc, bid, size } = boardOf(1000);
    const host = mountShell(doc, bid, Math.ceil((size / 0.86) / BOARD_SHARE));
    const ban = host.querySelector(".ocdg-ban.warn")!;
    expect(ban.getAttribute("role")).toBe("status");
    expect(ban.textContent).toContain("close to its size limit");
    expect(host.querySelector(".ocdg-chip.warn")).not.toBeNull();
    act(() => ban.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click());
    expect(host.querySelector(".ocdg-ban")).toBeNull();
    expect(host.querySelector(".ocdg-chip.warn")).not.toBeNull();
  });
  it("red over 100 %: not dismissible; editing still works; re-measured after edits", async () => {
    const { doc, bid, size } = boardOf(1000);
    const host = mountShell(doc, bid, Math.ceil((size / 0.9) / BOARD_SHARE));
    expect(host.querySelector(".ocdg-ban.warn")).not.toBeNull();
    act(() => void addShape(doc, bid, { type: "text", x: 0, y: 0, text: "y".repeat(400) }));
    await vi.waitFor(() => expect(host.querySelector(".ocdg-ban.over")).not.toBeNull(), { timeout: 10_000 });
    const ban = host.querySelector(".ocdg-ban.over")!;
    expect(ban.getAttribute("role")).toBe("alert");
    expect(ban.querySelector('[aria-label="Dismiss"]')).toBeNull();
  });
  it("What uses space: parts, largest parts with Select, the whole document", () => {
    const { doc, bid, size } = boardOf(1000);
    const select = vi.fn();
    const host = mountShell(doc, bid, Math.ceil((size / 0.9) / BOARD_SHARE), select);
    act(() => host.querySelector<HTMLButtonElement>(".ocdg-ban .ocdg-bb")!.click());
    const dlg = document.querySelector('[role="dialog"][aria-labelledby="ocdg-space-h"]')!;
    expect(dlg.textContent).toContain("Text and properties");
    expect(dlg.textContent).toContain("Undo history is not counted");
    act(() => dlg.querySelector<HTMLButtonElement>('[aria-label="Select Container “Big”"]')!.click());
    expect(select).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[aria-labelledby="ocdg-space-h"]')).toBeNull();
  });
});
