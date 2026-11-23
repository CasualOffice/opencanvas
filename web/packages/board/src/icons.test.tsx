// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-17 part 1: built-in generic icons (data, search, the Icons library in the shapes panel,
// the icon:node shape on the canvas and in exports).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";
import { KIND_MIME } from "./libraries";
import { descriptorOf } from "./registry";
import { GENERIC_ICONS, ICON_CATEGORIES, ICON_KIND, ICON_MIME, iconNodeFields, searchIcons, suggestIcons } from "./icons";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH_RE = /^[MLHVCSQTAZmlhvcsqtaz0-9 ,.\-]{1,2000}$/;

const env = (role: "edit" | "view" = "edit"): BlockEnv => ({ role, compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
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
  }, { timeout: 20_000 });
const btn = (root: ParentNode, name: string) => [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
async function open(doc: Y.Doc, id: string) {
  const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
  act(() => btn(el, "Diagram")!.click());
  await until(() => expect(document.querySelector(".ocdg")).toBeTruthy());
  return document.querySelector<HTMLElement>(".ocdg")!;
}
const type = (input: HTMLInputElement, v: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const all = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);

describe("generic icon data (icons/generic.json)", () => {
  it("has the approved groups and generic icons only, as stroked path data", () => {
    expect(ICON_CATEGORIES.map((c) => c.name)).toEqual(["Compute", "Storage and data", "Network", "Messaging and events", "Real-time and media", "Security and identity", "People and clients", "Operations", "General"]);
    const count = (cat: string) => GENERIC_ICONS.filter((i) => i.category === cat).length;
    expect(ICON_CATEGORIES.map((c) => count(c.id))).toEqual([8, 7, 11, 6, 5, 5, 7, 4, 6]);
    expect(new Set(GENERIC_ICONS.map((i) => i.id)).size).toBe(GENERIC_ICONS.length);
    for (const i of GENERIC_ICONS) {
      expect(i.paths.length).toBeGreaterThan(0);
      for (const d of i.paths) expect(d).toMatch(PATH_RE);
      expect(["lucide", "opencanvas"]).toContain(i.source);
    }
    // Our own drawings where Lucide has none (frame 1b and the brief).
    const own = GENERIC_ICONS.filter((i) => i.source === "opencanvas").map((i) => i.id);
    for (const id of ["object-storage", "api-gateway", "load-balancer", "reverse-proxy", "cdn", "dns", "vpn-tunnel", "service-mesh", "queue", "event-bus", "video-bridge", "relay", "vault", "data-warehouse", "cache", "service", "identity-provider", "pod", "cluster"]) expect(own).toContain(id);
  });

  it("finds generic icons by product keywords; nothing for a product we ship no logo for", () => {
    expect(searchIcons("s3").map((h) => [h.id, h.keyword])).toEqual([["object-storage", "s3"]]);
    expect(searchIcons("redis")[0]).toMatchObject({ id: "cache", keyword: "redis" });
    expect(searchIcons("kafka")[0]).toMatchObject({ id: "event-bus", keyword: "kafka" });
    expect(searchIcons("gateway")[0]).toMatchObject({ id: "api-gateway", at: [4, 11] });
    expect(searchIcons("jitsi")).toEqual([]);
    expect(suggestIcons("Jitsi").map((i) => i.name)).toEqual(["Video bridge", "Video call", "Relay"]);
    expect(suggestIcons("qwerty")).toEqual([]);
  });

  it("is the kind icon:node on the rect base; older readers draw the rect with its label", () => {
    const d = descriptorOf({ type: "rect", kind: ICON_KIND });
    expect(d).toMatchObject({ kind: ICON_KIND, base: "rect", bindable: true });
    expect(iconNodeFields("cdn", [100, 100])).toMatchObject({ type: "rect", kind: ICON_KIND, x: 74, y: 74, w: 52, h: 52, text: "CDN", fill: "purple", props: { icon: "cdn", labelPos: "below" } });
    expect(iconNodeFields("nope", [0, 0])).toBeNull();
  });
});

describe("Icons library in the shapes panel (1a-1e)", { timeout: 60_000 }, () => {
  it("lists the icon groups; Compute and Storage open; a tile adds an icon shape", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const panel = dg.querySelector<HTMLElement>('aside[aria-label="Shapes"]')!;
    const lib = panel.querySelector<HTMLElement>('[data-library="icons"]')!;
    expect(lib.querySelector(".ocdg-lh")!.textContent).toBe(`Icons${GENERIC_ICONS.length}`);
    const groups = [...lib.querySelectorAll(".ocdg-ig")].map((g) => g.querySelector("button")!.textContent);
    expect(groups[0]).toBe("Compute8");
    expect(lib.querySelectorAll('.ocdg-ig[data-group="compute"] .ocdg-tile')).toHaveLength(8);
    expect(lib.querySelectorAll('.ocdg-ig[data-group="storage"] .ocdg-tile')).toHaveLength(7);
    expect(lib.querySelectorAll('.ocdg-ig[data-group="network"] .ocdg-tile')).toHaveLength(0);
    act(() => btn(lib, "Add Object storage icon")!.click());
    expect(all(doc, id)[0]).toMatchObject({ type: "rect", kind: ICON_KIND, text: "Object storage", fill: "blue", w: 52, h: 52, props: { icon: "object-storage", labelPos: "below" } });
    // Drawn on the canvas with its glyph and label.
    const g = dg.querySelector(`[data-s="${all(doc, id)[0].id}"]`)!;
    expect(g.getAttribute("data-kind")).toBe(ICON_KIND);
    expect(g.querySelectorAll("path").length).toBe(GENERIC_ICONS.find((i) => i.id === "object-storage")!.paths.length);
    expect(g.textContent).toContain("Object storage");
  });

  it("search “s3” finds the generic bucket and says it is not the vendor logo", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const input = dg.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!;
    type(input, "s3");
    const tile = dg.querySelector<HTMLElement>('.ocdg-tile[data-icon="object-storage"]')!;
    expect(tile.textContent).toContain("s3");
    expect(dg.querySelector(".ocdg-ihint")!.textContent).toContain("not a vendor logo");
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(all(doc, id)[0]).toMatchObject({ kind: ICON_KIND, props: { icon: "object-storage" } });
  });

  it("search “jitsi” offers Add your own icon and generic alternatives", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const input = dg.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!;
    type(input, "jitsi");
    const none = dg.querySelector(".ocdg-none")!;
    expect(none.textContent).toContain("No built-in icon for “jitsi”");
    expect(btn(none, "Add your own icon")).toBeTruthy();
    expect([...none.querySelectorAll(".ocdg-tile")].map((t) => t.getAttribute("data-icon"))).toEqual(["video-bridge", "video-call", "relay"]);
    // Search for other shapes still says there is nothing.
    type(input, "zzz");
    expect(dg.querySelector(".ocdg-none")!.textContent).toContain("No shapes match “zzz”.");
  });

  it("an icon tile dragged onto the canvas lands centred there", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const data = new Map<string, string>();
    const dt = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", types: [] as string[], effectAllowed: "", dropEffect: "" };
    const start = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.assign(start, { dataTransfer: dt });
    act(() => void dg.querySelector('.ocdg-tile[data-icon="server"]')!.dispatchEvent(start));
    expect(data.get(KIND_MIME)).toBe(ICON_KIND);
    expect(data.get(ICON_MIME)).toBe("server");
    dt.types = [KIND_MIME, ICON_MIME];
    const layer = dg.querySelector("svg.ocbd-svg > g[transform]")!;
    const [, tx, ty, z] = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(layer.getAttribute("transform")!)!.map(Number);
    for (const t of ["dragover", "drop"]) {
      const e = new Event(t, { bubbles: true, cancelable: true });
      Object.assign(e, { dataTransfer: dt, clientX: 500 * z + tx, clientY: 300 * z + ty });
      act(() => void dg.querySelector(".ocbd")!.dispatchEvent(e));
    }
    // 52 × 52 centred on (500, 300) is (474, 274): on the 20 grid (480, 280).
    expect(all(doc, id)[0]).toMatchObject({ kind: ICON_KIND, x: 480, y: 280, props: { icon: "server" } });
  });

  it("draws an icon this build doesn't have as an empty icon frame (6a)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const s = addShape(doc, id, { type: "rect", kind: ICON_KIND, kindVersion: 1, x: 0, y: 0, w: 52, h: 52, text: "Gone", props: { icon: "no-such" } });
    const dg = await open(doc, id);
    const g = dg.querySelector(`[data-s="${s}"]`)!;
    expect(g.querySelector("[data-missing-icon]")).toBeTruthy();
    expect(g.textContent).toContain("Gone");
  });
});

describe("Network library uses the new drawings (decision 6)", () => {
  it("load balancer, API gateway and queue draw the generic icon glyphs", () => {
    for (const [kind, icon] of [["network:load-balancer", "load-balancer"], ["network:api-gateway", "api-gateway"], ["network:queue", "queue"]]) {
      expect(descriptorOf({ type: "rect", kind }).look?.icon).toBe(icon);
    }
  });
});
