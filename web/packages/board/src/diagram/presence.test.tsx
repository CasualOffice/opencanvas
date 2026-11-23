// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S10: working together (approved prototype 10a-10c).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addShape, createBoard, deleteShape, getBoardMap, readShapes, type Shape } from "../model";
import { withResolvedArrows } from "../connectors";
import { OrphanLayer, looseEnds } from "./Presence";
import { Properties } from "./props/Properties";
import Shell, { type DiagramPeer } from "./Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
});
function mount(node: () => React.ReactNode, doc?: Y.Doc) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const r = () => act(() => root.render(node()));
  r();
  doc?.on("update", r);
  cleanups.push(() => act(() => root.unmount()));
  return el;
}

/** Inventory service → Stock cache, bound at both ends. */
function board() {
  const doc = new Y.Doc();
  const bid = createBoard(doc, "blank");
  const a = addShape(doc, bid, { type: "rect", x: 0, y: 0, w: 120, h: 60, text: "Inventory service" });
  const b = addShape(doc, bid, { type: "rect", x: 300, y: 0, w: 120, h: 60, text: "Stock cache" });
  const c = addShape(doc, bid, { type: "arrow", pts: [[120, 30], [300, 30]], start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" } });
  const all = () => withResolvedArrows(readShapes(getBoardMap(doc, bid)!));
  return { doc, bid, a, b, c, all };
}

describe("orphan connector (10b)", { timeout: 30_000 }, () => {
  it("draws red dashed with a faint outline of the deleted shape, and reattaches on undo", () => {
    const { doc, bid, b, c, all } = board();
    const um = new Y.UndoManager(getBoardMap(doc, bid)!, { trackedOrigins: new Set(["me"]) });
    const el = mount(() => <svg><OrphanLayer boardId={bid} shapes={all()} z={1} /></svg>, doc);
    expect(el.querySelector("[data-orphan]")).toBeNull();
    act(() => deleteShape(doc, bid, b, "me"));
    const o = el.querySelector(`[data-orphan="${c}"]`)!;
    expect(o).not.toBeNull();
    expect(o.querySelector("path")!.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(o.querySelector(`[data-ghost="${b}"]`)!.textContent).toBe("Stock cache");
    // The binding is kept in the document.
    const conn = all().find((s) => s.id === c)!;
    expect(conn.end!.shapeId).toBe(b);
    expect(looseEnds(conn, (id) => all().some((s) => s.id === id))).toEqual(["end"]);
    act(() => void um.undo());
    expect(el.querySelector("[data-orphan]")).toBeNull();
    expect(all().find((s) => s.id === c)!.pts!.at(-1)).toEqual([300, 30]);
  });
  it("the panel explains it and offers Reconnect and Delete connector", () => {
    const { doc, bid, b, c, all } = board();
    mount(() => <svg><OrphanLayer boardId={bid} shapes={all()} z={1} /></svg>, doc);
    act(() => deleteShape(doc, bid, b));
    // A new shape where the old one was: Reconnect binds the loose end to it.
    const n = addShape(doc, bid, { type: "rect", x: 310, y: 0, w: 100, h: 60, text: "Redis" });
    const el = mount(() => <Properties doc={doc} boardId={bid} selected={[all().find((s) => s.id === c)!]} shapes={all()} edit />, doc);
    expect(el.querySelector(".ocdg-orphan")!.textContent).toContain("Stock cache was deleted.");
    act(() => [...el.querySelectorAll<HTMLButtonElement>(".ocdg-orphan button")].find((x) => x.textContent === "Reconnect")!.click());
    expect(all().find((s) => s.id === c)!.end!.shapeId).toBe(n);
    expect(el.querySelector(".ocdg-orphan")).toBeNull();
  });
  it("Delete connector removes it", () => {
    const { doc, bid, b, c, all } = board();
    act(() => deleteShape(doc, bid, b));
    const el = mount(() => {
      const s = all().find((x) => x.id === c);
      return s ? <Properties doc={doc} boardId={bid} selected={[s]} shapes={all()} edit /> : null;
    }, doc);
    act(() => [...el.querySelectorAll<HTMLButtonElement>(".ocdg-orphan button")].find((x) => x.textContent === "Delete connector")!.click());
    expect(all().some((s) => s.id === c)).toBe(false);
  });
});

const prefs = { grid: true, gridSize: 20, rulers: true, snapGrid: true, snapShapes: true, connector: "elbow" as const };
function shell(doc: Y.Doc, bid: string, sel: Shape[], peers: DiagramPeer[], role: "edit" | "view" = "edit") {
  const env = { role, compact: false, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} };
  return mount(() => (
    <Shell doc={doc} boardId={bid} env={env} anchor={() => null} place={{ heading: "", title: "" }} closing={false} onClosed={() => {}} onBack={() => {}} peers={peers} undo={{ can: false, run: () => {} }} redo={{ can: false, run: () => {} }} menuOpen={false} onMenu={() => {}} origin={null} prefs={prefs} onPrefs={() => {}} selected={sel} shapes={sel}>
      <div />
    </Shell>
  ));
}

describe("others on the same shape (10a) and view only (10c)", { timeout: 30_000 }, () => {
  it("says who else has the shape selected", () => {
    const { doc, bid, a, all } = board();
    const s = all().find((x) => x.id === a)!;
    const el = shell(doc, bid, [s], [{ id: 2, name: "Lea Fischer", color: "#c2410c", sel: [a] }, { id: 3, name: "Marco Bianchi", color: "#15803d", sel: ["other"] }]);
    expect(el.querySelector(".ocdg-peer")!.textContent).toContain("Lea is editing this shape too. If you change different fields, both changes are kept.");
    expect(el.querySelector(".ocdg-peer")!.textContent).not.toContain("Marco");
  });
  it("view only: no undo, read-only properties and Copy text", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { doc, bid, a, all } = board();
    const el = shell(doc, bid, [all().find((x) => x.id === a)!], [], "view");
    expect(el.querySelector('[aria-label="Undo"]')).toBeNull();
    const inputs = [...el.querySelectorAll<HTMLInputElement>('[aria-label="Properties"] input')];
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => i.readOnly || i.disabled)).toBe(true);
    const copy = [...el.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Copy text")!;
    act(() => copy.click());
    await vi.waitFor(() => expect(copy.textContent).toBe("Copied"), { timeout: 10_000 });
    expect(writeText).toHaveBeenCalledWith("Inventory service");
  });
});
