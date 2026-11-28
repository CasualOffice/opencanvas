// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Working together (board UX prototype 10a-10b, decision 12): named cursors whose label fades
// after 4 s still (the arrow stays), selection rings, avatars with Follow and Go to cursor.
// Following uses the viewport in awareness only (never document data); pan, zoom or Esc stop it.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "../index";
import { addShape } from "../model";
import { inkOn, readPeer } from "./awareness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "p", name: "Priya", color: "#2a5ad7" }, users: [], toast: () => {} });
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
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

function setup() {
  const doc = new Y.Doc();
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 20, y: 20, w: 100, h: 60, text: "A" });
  const local = new Awareness(doc);
  const remote = new Awareness(new Y.Doc());
  const send = (board: Record<string, unknown> | null) => {
    remote.setLocalState({ user: { name: "Lea Novak", color: "#7a45f0" }, board: board ? { id, ...board } : null });
    act(() => applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), "remote"));
  };
  return { doc, id, a, local, remote, send };
}
const world = (el: Element) => el.querySelector("svg.ocbd-svg > g[transform]")!.getAttribute("transform");

describe("awareness", () => {
  it("reads a peer's viewport, cursor and selection defensively", () => {
    expect(readPeer({ id: "b", x: 1, y: 2, sel: ["s"], vp: [10, 20, 2] }, "b")).toEqual({ x: 1, y: 2, sel: ["s"], vp: [10, 20, 2] });
    expect(readPeer({ id: "b", vp: ["x", 1, 2] }, "b")).toEqual({ x: null, y: null, sel: [], vp: null });
    expect(readPeer({ id: "c", x: 1, y: 2 }, "b")).toBeNull();
    expect(readPeer({ id: "b", vp: [1, 2, 0] }, "b")?.vp).toBeNull();
  });
});

describe("name colours", () => {
  it("text on a person's colour is white or near-black, whichever passes contrast", () => {
    expect(inkOn("#e5602a")).toBe("#18181b");
    expect(inkOn("#2a5ad7")).toBe("#fff");
    expect(inkOn("var(--u2)")).toBe("#fff");
  });
  it("avatars and cursor labels use it", () => {
    const { doc, id, local, send } = setup();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} awareness={local} />);
    send({ x: 10, y: 10, vp: [0, 0, 1] });
    expect(el.querySelector<HTMLElement>('.ocbd-people button')!.style.color).toBe("rgb(255, 255, 255)");
    expect(el.querySelector('.ocbd-cursor text')!.getAttribute("fill")).toBe("#fff");
  });
});

describe("working together", { timeout: 60_000 }, () => {
  it("publishes this view's viewport in awareness", () => {
    const { doc, id, local } = setup();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} awareness={local} />);
    // Nothing until the pointer or focus is on this board (a page may hold several boards).
    expect(local.getLocalState()?.board ?? null).toBeNull();
    act(() => el.querySelector<HTMLElement>(".ocbd")!.focus());
    const vp = (local.getLocalState()?.board as { vp?: number[] } | undefined)?.vp;
    expect(vp).toHaveLength(3);
  });

  it("a cursor's name fades after 4 s still; the arrow stays", () => {
    vi.useFakeTimers();
    const { doc, id, local, send } = setup();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} awareness={local} />);
    send({ x: 200, y: 100 });
    const cur = el.querySelector(".ocbd-cursor")!;
    expect(cur.textContent).toContain("Lea Novak");
    expect(cur.querySelector(".ocbd-clabel")!.getAttribute("opacity")).toBe("1");
    act(() => void vi.advanceTimersByTime(4100));
    expect(el.querySelector(".ocbd-cursor .ocbd-clabel")!.getAttribute("opacity")).toBe("0");
    expect(el.querySelector(".ocbd-cursor path")).toBeTruthy();
    // Moving brings the name back.
    send({ x: 220, y: 100 });
    expect(el.querySelector(".ocbd-cursor .ocbd-clabel")!.getAttribute("opacity")).toBe("1");
  });

  it("avatars offer Follow and Go to cursor; following tracks their viewport until Esc", () => {
    const { doc, id, local, send } = setup();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} awareness={local} />);
    send({ x: 300, y: 150, vp: [500, 400, 2] });
    const people = el.querySelector('[role="group"][aria-label="People on this board"]')!;
    const av = people.querySelector<HTMLButtonElement>('button[aria-label="Lea Novak"]')!;
    expect(av).toBeTruthy();
    act(() => av.click());
    const menu = el.querySelector('[role="menu"][aria-label="Lea Novak"]')!;
    const items = [...menu.querySelectorAll("[role=menuitem]")].map((b) => b.textContent);
    expect(items).toEqual(["Follow", "Go to cursor"]);
    // Go to cursor centres their cursor (zoom unchanged).
    act(() => menu.querySelector<HTMLButtonElement>("[role=menuitem]:nth-child(2)")!.click());
    expect(world(el)).toBe("translate(-300 -150) scale(1)");
    act(() => av.click());
    act(() => el.querySelector<HTMLButtonElement>('[role="menu"] [role=menuitem]')!.click());
    expect(world(el)).toBe("translate(-1000 -800) scale(2)");
    const banner = el.querySelector(".ocbd-follow")!;
    expect(banner.textContent).toContain("Following Lea Novak");
    expect(banner.querySelector("button")!.textContent).toBe("Stop");
    // Their view moves: so does ours.
    send({ x: 300, y: 150, vp: [600, 400, 1] });
    expect(world(el)).toBe("translate(-600 -400) scale(1)");
    key(el.querySelector(".ocbd")!, "Escape");
    expect(el.querySelector(".ocbd-follow")).toBeNull();
    send({ x: 300, y: 150, vp: [0, 0, 1] });
    expect(world(el)).toBe("translate(-600 -400) scale(1)");
  });

  it("selection rings carry the person's name and colour", () => {
    const { doc, id, a, local, send } = setup();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} awareness={local} />);
    send({ sel: [a] });
    const ring = el.querySelector(".ocbd-peersel")!;
    expect(ring.textContent).toContain("Lea Novak");
    expect(ring.querySelector("rect")!.getAttribute("stroke")).toBe("#7a45f0");
  });
});
