// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-17 part 3: Add your own icon (frames 2a-2f), In this document (3a), Manage (3b-3d), the
// missing icon (6a). The server is faked: `api` writes the `icons` root as the server would.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { IconError, type BlockEnv, type IconApi, type IconCheck } from "@opencanvas/ui";
import { BoardBlock, createBoard } from "./index";
import { addShape, getBoardMap, readShapes } from "./model";
import { ICON_KIND } from "./icons";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2H22V22Z"/></svg>`;
const B64 = btoa(SVG);
const CHECK: IconCheck = { format: "svg", width: 24, height: 24, bytes: 120, removed: [{ what: "Scripts", count: 1 }, { what: "Event handlers", count: 2 }], dataUrl: `data:image/svg+xml;base64,${B64}` };

/** What the server does: write the `icons` root (here straight into the doc). */
function serverIcon(doc: Y.Doc, id: string, name: string, keywords: string[] = []) {
  doc.transact(() => {
    const e = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ name, keywords, format: "svg", data: B64, width: 24, height: 24, bytes: 120, by: "priya", byName: "Priya Shah", at: "2026-11-24T10:00:00Z" })) e.set(k, v);
    doc.getMap("icons").set(id, e);
  }, "server");
}

function fakeApi(doc: Y.Doc, over: Partial<IconApi> = {}): IconApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check: vi.fn(async () => (calls.push("check"), CHECK)),
    add: vi.fn(async (_f: Blob, name: string, keywords: string[]) => {
      calls.push(`add:${name}:${keywords.join(",")}`);
      serverIcon(doc, "i1", name, keywords);
      return { id: "i1" };
    }),
    replace: vi.fn(async (id: string) => void calls.push(`replace:${id}`)),
    rename: vi.fn(async (id: string, name: string) => {
      calls.push(`rename:${id}:${name}`);
      (doc.getMap("icons").get(id) as Y.Map<unknown>).set("name", name);
    }),
    remove: vi.fn(async (id: string) => {
      calls.push(`remove:${id}`);
      doc.getMap("icons").delete(id);
    }),
    ...over,
  };
}

const env = (icons?: IconApi, toast: BlockEnv["toast"] = () => {}): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast, icons });
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
async function open(doc: Y.Doc, id: string, e: BlockEnv) {
  const el = mount(<BoardBlock doc={doc} boardId={id} env={e} />);
  act(() => btn(el, "Diagram")!.click());
  await until(() => expect(document.querySelector(".ocdg")).toBeTruthy());
  return document.querySelector<HTMLElement>(".ocdg")!;
}
const type = (input: HTMLInputElement, v: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
/** Waits for an element (polling inside act, no fixed waits). */
async function found(sel: string): Promise<HTMLElement> {
  await until(() => expect(document.querySelector(sel)).toBeTruthy());
  return document.querySelector<HTMLElement>(sel)!;
}
const all = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const choose = (input: HTMLInputElement, file: File) =>
  act(() => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

describe("In this document (3a)", { timeout: 60_000 }, () => {
  it("is empty with one line and Add icon; Add icon is disabled without a server", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const dg = await open(doc, id, env());
    const sec = dg.querySelector<HTMLElement>('[data-library="doc-icons"]')!;
    expect(sec.textContent).toContain("Logos and icons you add are kept in this document");
    expect(btn(sec, "Add icon")!.disabled).toBe(true);
  });

  it("lists the document's icons; a tile places one; search finds it by name (1f)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    serverIcon(doc, "jm", "Jitsi Meet", ["video"]);
    const dg = await open(doc, id, env(fakeApi(doc)));
    const sec = dg.querySelector<HTMLElement>('[data-library="doc-icons"]')!;
    const tile = sec.querySelector<HTMLElement>('.ocdg-tile[data-icon="doc:jm"]')!;
    expect(tile.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    act(() => tile.click());
    expect(all(doc, id)[0]).toMatchObject({ type: "rect", kind: ICON_KIND, text: "Jitsi Meet", props: { icon: "doc:jm" } });
    // Drawn as an <image> with a data: URL, never inline markup.
    const g = dg.querySelector(`[data-s="${all(doc, id)[0].id}"]`)!;
    expect(g.querySelector("image")!.getAttribute("href")).toMatch(/^data:image\/svg\+xml;base64,/);
    const input = dg.querySelector<HTMLInputElement>('input[aria-label="Search shapes"]')!;
    type(input, "jitsi");
    await until(() => expect(dg.querySelector('section[aria-label="In this document"] .ocdg-tile[data-icon="doc:jm"]')).toBeTruthy());
    expect(dg.querySelector(".ocdg-noicon")).toBeNull();
  });

  it("an icon removed from the document draws the empty frame and keeps its label (6a)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const s = addShape(doc, id, { type: "rect", kind: ICON_KIND, kindVersion: 1, x: 0, y: 0, w: 52, h: 52, text: "Gone", props: { icon: "doc:gone" } });
    const dg = await open(doc, id, env());
    const g = dg.querySelector(`[data-s="${s}"]`)!;
    expect(g.querySelector("[data-missing-icon]")).toBeTruthy();
    expect(g.textContent).toContain("Gone");
  });
});

describe("Add icon (2a-2d, 2f)", { timeout: 60_000 }, () => {
  it("checks the file on the server, shows the report by name and previews, then adds and places it", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const api = fakeApi(doc);
    const dg = await open(doc, id, env(api));
    act(() => btn(dg.querySelector('[data-library="doc-icons"]')!, "Add icon")!.click());
    const dlg = await found('[role="dialog"][aria-labelledby="ocdg-ai-t"]');
    expect(dlg.textContent).toContain("Drop an SVG or PNG here");
    expect(dlg.textContent).toContain("Only add logos and icons you are allowed to use");
    choose(dlg.querySelector<HTMLInputElement>('input[type="file"]')!, new File([SVG], "jitsi-logo.svg", { type: "image/svg+xml" }));
    await until(() => expect(dlg.textContent).toContain("We removed 3 things that icons can’t contain"));
    expect(dlg.textContent).toContain("Scripts");
    expect(dlg.textContent).toContain("Event handlers");
    // Previews at 16, 24 and 48 px on light and dark.
    expect(dlg.querySelectorAll(".ocdg-aipv img")).toHaveLength(6);
    const name = dlg.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(name.value).toBe("Jitsi logo");
    type(name, "Jitsi Meet");
    const kw = dlg.querySelector<HTMLInputElement>('input[aria-label="Keywords"]')!;
    type(kw, "video, meetings");
    act(() => btn(dlg, "Add icon")!.click());
    await until(() => expect(all(doc, id)).toHaveLength(1));
    expect(api.calls).toContain("add:Jitsi Meet:video,meetings");
    expect(all(doc, id)[0]).toMatchObject({ kind: ICON_KIND, text: "Jitsi Meet", props: { icon: "doc:i1" } });
    expect(document.querySelector('[aria-labelledby="ocdg-ai-t"]')).toBeNull();
  });

  it("says why a file is refused and offers another", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const api = fakeApi(doc, { check: vi.fn(async () => Promise.reject(new IconError("too_large", "This file is over 256 KB. Icons must be 256 KB or smaller."))) });
    const dg = await open(doc, id, env(api));
    act(() => btn(dg.querySelector('[data-library="doc-icons"]')!, "Add icon")!.click());
    const dlg = await found('[aria-labelledby="ocdg-ai-t"]');
    choose(dlg.querySelector<HTMLInputElement>('input[type="file"]')!, new File(["x"], "platform-map.svg", { type: "image/svg+xml" }));
    await until(() => expect(dlg.textContent).toContain("This file can’t be used as an icon."));
    expect(dlg.textContent).toContain("This file is over 256 KB.");
    expect(dlg.textContent).toContain("Other reasons a file is refused");
    expect(btn(dlg, "Choose another file")).toBeTruthy();
  });

  it("pasting an SVG onto the board still makes a picture and offers a reusable icon (2e)", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const toast = vi.fn();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env(fakeApi(doc), toast)} />);
    const file = new File([SVG], "logo.svg", { type: "image/svg+xml" });
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(e, { dataTransfer: { files: [file], items: [], types: ["Files"], getData: () => "" }, clientX: 100, clientY: 100 });
    act(() => void el.querySelector(".ocbd")!.dispatchEvent(e));
    await until(() => expect(all(doc, id)).toHaveLength(1));
    expect(all(doc, id)[0].type).toBe("image");
    await until(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("Image added"), expect.objectContaining({ label: "Make it a reusable icon" })));
  });
});

describe("Icons in this document (3b-3d)", { timeout: 60_000 }, () => {
  it("renames, and removing an icon in use says what happens; shapes keep their labels", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    serverIcon(doc, "jm", "Jitsi Meet", ["video"]);
    const s = addShape(doc, id, { type: "rect", kind: ICON_KIND, kindVersion: 1, x: 0, y: 0, w: 52, h: 52, text: "Jitsi Meet", props: { icon: "doc:jm" } });
    const api = fakeApi(doc);
    const dg = await open(doc, id, env(api));
    act(() => btn(dg.querySelector('[data-library="doc-icons"]')!, "Manage icons")!.click());
    const dlg = await found('[aria-labelledby="ocdg-mi-t"]');
    expect(dlg.textContent).toContain("Jitsi Meet");
    expect(dlg.textContent).toContain("Used 1×");
    expect(dlg.textContent).toContain("of 1 MB for icons · 1 of 200");
    act(() => btn(dlg, "Rename Jitsi Meet")!.click());
    const name = dlg.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    type(name, "Jitsi");
    act(() => btn(dlg, "Save")!.click());
    await until(() => expect(api.calls).toContain("rename:jm:Jitsi"));
    await until(() => expect(dlg.textContent).toContain("Jitsi"));
    act(() => btn(dlg, "Remove Jitsi")!.click());
    const confirm = await found('[role="alertdialog"]');
    expect(confirm.textContent).toContain("It is used by 1 shape on 1 board.");
    act(() => btn(confirm, "Remove")!.click());
    await until(() => expect(api.calls).toContain("remove:jm"));
    await until(() => expect(dg.querySelector(`[data-s="${s}"] [data-missing-icon]`)).toBeTruthy());
    expect(all(doc, id)[0].text).toBe("Jitsi Meet");
  });
});
