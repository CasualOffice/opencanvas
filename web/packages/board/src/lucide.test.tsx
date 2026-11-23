// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-17: the full Lucide set as diagram icons (lazy index and per-category path data; a placed
// icon embeds its path data).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { getBoardMap, readShapes } from "./model";
import { shapesToSvg } from "./export";
import { ICON_KIND, iconDragData, iconNodeFields, iconPathsOf, readIconDrag } from "./icons";
import { loadLucideIndex, lucidePaths, PATH_RE, searchLucide } from "./lucide";
import pkg from "../package.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} });
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

describe("Lucide data", () => {
  it("indexes every Lucide icon of the lucide-react version we ship, in categories, no brands", async () => {
    const idx = await loadLucideIndex();
    expect(idx.version).toBe(pkg.dependencies["lucide-react"].replace(/^[\^~]/, ""));
    expect(idx.icons.length).toBeGreaterThan(2000);
    expect(idx.categories.length).toBeGreaterThan(40);
    expect(idx.icons.map((i) => i[0])).not.toContain("github");
    const hits = searchLucide(idx, "rocket");
    expect(hits[0]).toMatchObject({ name: "rocket", at: [0, 6] });
    expect(searchLucide(idx, "jitsi")).toEqual([]);
    // Tags find icons whose name doesn't say it.
    expect(searchLucide(idx, "storage").some((h) => h.tag)).toBe(true);
    const paths = (await lucidePaths("rocket"))!;
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(d).toMatch(PATH_RE);
  });

  it("a placed Lucide icon embeds its checked path data", async () => {
    const paths = (await lucidePaths("rocket"))!;
    const f = iconNodeFields("lucide:rocket", [0, 0], paths)!;
    expect(f).toMatchObject({ type: "rect", kind: ICON_KIND, text: "Rocket", fill: "gray", props: { icon: "lucide:rocket", paths } });
    expect(iconNodeFields("lucide:rocket", [0, 0], ['M0 0"/><script>'])).toBeNull();
    expect(iconNodeFields("lucide:../x", [0, 0], paths)).toBeNull();
    expect(iconPathsOf({ ...f, id: "a" })).toEqual(paths);
    expect(iconPathsOf({ ...f, id: "a", props: { icon: "lucide:rocket", paths: ["M0 0<x>"] } })).toBeNull();
    expect(readIconDrag(iconDragData("lucide:rocket", paths))).toEqual({ id: "lucide:rocket", paths });
    expect(readIconDrag('{"id":"lucide:x","paths":["<svg>"]}')).toBeUndefined();
    expect(readIconDrag("{not json")).toBeUndefined();
    // Exports draw it from the shape alone; forged path data falls back to the plain rect.
    const svg = shapesToSvg([{ id: "a", ...f }]);
    expect(svg).toContain(`<path d="${paths[0]}"/>`);
    const forged = shapesToSvg([{ id: "a", ...f, props: { icon: "lucide:x", paths: ['M0 0"/><script>'] } }]);
    expect(forged).not.toContain("script");
  });
});

describe("All icons in the shapes panel", { timeout: 60_000 }, () => {
  it("opens a virtualised, categorised grid; a tile adds the icon with its paths", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const sec = dg.querySelector<HTMLElement>('[data-library="lucide"]')!;
    expect(sec).toBeTruthy();
    act(() => (sec.querySelector(".ocdg-lh button") as HTMLElement).click());
    await until(() => expect(sec.querySelector('select[aria-label="Category"]')).toBeTruthy());
    // Virtualised: only a window of the 2,000+ tiles is in the DOM.
    await until(() => expect(sec.querySelectorAll(".ocdg-tile").length).toBeGreaterThan(5));
    expect(sec.querySelectorAll(".ocdg-tile").length).toBeLessThan(120);
    const sel = sec.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!;
    act(() => {
      sel.value = "gaming";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Gaming starts with Anvil; Rocket (the 68th) is drawn only once its row scrolls into view.
    await until(() => expect(sec.querySelector('.ocdg-tile[data-icon="lucide:anvil"]:not(:disabled)')).toBeTruthy());
    expect(sec.querySelector('.ocdg-tile[data-icon="lucide:rocket"]')).toBeNull();
    const grid = sec.querySelector<HTMLElement>(".ocdg-allg")!;
    act(() => {
      grid.scrollTop = 22 * 4.5 * 16;
      grid.dispatchEvent(new Event("scroll"));
    });
    await until(() => expect(sec.querySelector('.ocdg-tile[data-icon="lucide:rocket"]:not(:disabled)')).toBeTruthy());
    act(() => (sec.querySelector('.ocdg-tile[data-icon="lucide:rocket"]') as HTMLElement).click());
    expect(all(doc, id)[0]).toMatchObject({ kind: ICON_KIND, text: "Rocket", props: { icon: "lucide:rocket" } });
    expect((all(doc, id)[0].props as { paths: string[] }).paths.length).toBeGreaterThan(0);
    const g = dg.querySelector(`[data-s="${all(doc, id)[0].id}"]`)!;
    expect(g.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("search reaches every Lucide icon; Enter adds the first when nothing else matches", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id);
    const input = dg.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!;
    type(input, "rocket");
    await until(() => expect(dg.querySelector('.ocdg-lscroll .ocdg-tile[data-icon="lucide:rocket"]')).toBeTruthy());
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await until(() => expect(all(doc, id)[0]).toMatchObject({ kind: ICON_KIND, props: { icon: "lucide:rocket" } }));
    // A product we ship no logo for still says so.
    type(input, "jitsi");
    await until(() => expect(dg.querySelector(".ocdg-none")!.textContent).toContain("No built-in icon for “jitsi”"));
  });
});
