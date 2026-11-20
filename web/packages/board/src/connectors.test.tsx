// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv, Role } from "@opencanvas/ui";
import { BoardBlock, createBoard, exportBoardPng, exportBoardSvg } from "./index";
import { anchorPoint, boundaryToward, elbow, resolveArrow, snapTarget, syncBoundArrows, withResolvedArrows } from "./connectors";
import { addShape, getBoardMap, readShapes, updateShape, type Shape } from "./model";
import { fitImage, ImageError, imageSource, MAX_INLINE_IMAGE } from "./images";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shapes = (doc: Y.Doc, id: string) => readShapes(getBoardMap(doc, id)!);
const one = (doc: Y.Doc, id: string, sid: string) => shapes(doc, id).find((s) => s.id === sid)!;
const resolved = (doc: Y.Doc, id: string, sid: string) => withResolvedArrows(shapes(doc, id)).find((s) => s.id === sid)!.pts!;
const toasts: string[] = [];
const env = (role: Role = "edit", extra: Partial<BlockEnv> = {}): BlockEnv => ({
  role,
  compact: false,
  me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" },
  users: [],
  toast: (m) => void toasts.push(m),
  ...extra,
});

/** Two boxes and a free arrow between them. */
function fixture(doc = new Y.Doc()) {
  const id = createBoard(doc, "blank");
  const a = addShape(doc, id, { type: "rect", x: 0, y: 0, w: 100, h: 60 });
  const b = addShape(doc, id, { type: "rect", x: 300, y: 200, w: 100, h: 60 });
  const ar = addShape(doc, id, { type: "arrow", pts: [[120, 30], [280, 230]] });
  return { doc, id, a, b, ar };
}

describe("connector geometry", () => {
  const box: Shape = { id: "r", type: "rect", x: 0, y: 0, w: 100, h: 60 };
  it("anchors sit on the box midpoints", () => {
    expect(anchorPoint(box, "top")).toEqual([50, 0]);
    expect(anchorPoint(box, "right")).toEqual([100, 30]);
    expect(anchorPoint(box, "bottom")).toEqual([50, 60]);
    expect(anchorPoint(box, "left")).toEqual([0, 30]);
    expect(anchorPoint(box, "center")).toEqual([50, 30]);
  });
  it("snaps to the nearest anchor of a nearby shape, or nothing", () => {
    expect(snapTarget([box], [96, 28])).toEqual({ shapeId: "r", anchor: "right" });
    expect(snapTarget([box], [48, 32])).toEqual({ shapeId: "r", anchor: "center" });
    expect(snapTarget([box], [50, -12])).toEqual({ shapeId: "r", anchor: "top" });
    expect(snapTarget([box], [300, 300])).toBeNull();
    expect(snapTarget([box], [96, 28], 18, "r")).toBeNull();
    expect(snapTarget([{ ...box, type: "pen", pts: [[0, 0], [100, 60]] }], [50, 30])).toBeNull();
  });
  it("clips centre bindings to the outline", () => {
    expect(boundaryToward(box, [500, 30])).toEqual([100, 30]);
    const el: Shape = { id: "e", type: "ellipse", x: 0, y: 0, w: 100, h: 100 };
    const p = boundaryToward(el, [100, 100]);
    expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeCloseTo(50, 5);
  });
  it("routes elbows orthogonally", () => {
    const pts = elbow([0, 0], [100, 50], "right", "left");
    expect(pts).toEqual([[0, 0], [50, 0], [50, 50], [100, 50]]);
    for (let i = 1; i < pts.length; i++) expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]).toBe(true);
    expect(elbow([0, 0], [100, 50], "right", "top")).toEqual([[0, 0], [100, 0], [100, 50]]);
    expect(elbow([0, 0], [100, 0], "right", "left")).toEqual([[0, 0], [100, 0]]);
  });
});

describe("bound connectors", () => {
  it("follow their shapes when they move or resize", () => {
    const { doc, id, a, b, ar } = fixture();
    updateShape(doc, id, ar, { start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" } });
    expect(resolved(doc, id, ar)).toEqual([[100, 30], [300, 230]]);
    updateShape(doc, id, b, { x: 500, y: 0 });
    expect(resolved(doc, id, ar)).toEqual([[100, 30], [500, 30]]);
    updateShape(doc, id, a, { h: 200 });
    expect(resolved(doc, id, ar)[0]).toEqual([100, 100]);
  });

  it("fall back to stored points when the bound shape is gone", () => {
    const { doc, id, a, ar } = fixture();
    updateShape(doc, id, ar, { start: { shapeId: a, anchor: "right" } });
    syncBoundArrows(doc, id);
    const stored = one(doc, id, ar).pts!;
    getBoardMap(doc, id)!.get("shapes") instanceof Y.Map && (getBoardMap(doc, id)!.get("shapes") as Y.Map<unknown>).delete(a);
    expect(resolved(doc, id, ar)).toEqual(stored);
  });

  it("syncBoundArrows rewrites stored pts only when they changed", () => {
    const { doc, id, a, b, ar } = fixture();
    updateShape(doc, id, ar, { start: { shapeId: a, anchor: "bottom" }, end: { shapeId: b, anchor: "top" }, route: "elbow" });
    syncBoundArrows(doc, id);
    expect(one(doc, id, ar).pts).toEqual([[50, 60], [50, 130], [350, 130], [350, 200]]);
    let writes = 0;
    doc.on("update", () => writes++);
    syncBoundArrows(doc, id);
    expect(writes).toBe(0);
  });

  it("survive concurrent edits: a shape moved on one side, the arrow bound on the other", () => {
    const { doc: a0, id, a, b, ar } = fixture();
    const b0 = new Y.Doc();
    Y.applyUpdate(b0, Y.encodeStateAsUpdate(a0));
    updateShape(a0, id, b, { x: 600, y: 400 });
    updateShape(b0, id, ar, { start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "top" } });
    Y.applyUpdate(a0, Y.encodeStateAsUpdate(b0));
    Y.applyUpdate(b0, Y.encodeStateAsUpdate(a0));
    expect(resolved(a0, id, ar)).toEqual([[100, 30], [650, 400]]);
    expect(resolved(b0, id, ar)).toEqual(resolved(a0, id, ar));
    expect(shapes(a0, id)).toEqual(shapes(b0, id));
  });

  it("concurrent rebinding of the same end converges", () => {
    const { doc: a0, id, a, b, ar } = fixture();
    const b0 = new Y.Doc();
    Y.applyUpdate(b0, Y.encodeStateAsUpdate(a0));
    updateShape(a0, id, ar, { end: { shapeId: a, anchor: "bottom" } });
    updateShape(b0, id, ar, { end: { shapeId: b, anchor: "left" } });
    Y.applyUpdate(a0, Y.encodeStateAsUpdate(b0));
    Y.applyUpdate(b0, Y.encodeStateAsUpdate(a0));
    expect(one(a0, id, ar).end).toEqual(one(b0, id, ar).end);
    expect(resolveArrow(one(a0, id, ar), new Map(shapes(a0, id).map((s) => [s.id, s])))).toEqual(resolved(b0, id, ar));
  });
});

/* ------------------------------------------------------------ UI */

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanup = () => act(() => root.unmount());
  return el;
}
// jsdom: no layout, so client coords == board coords (view at 0,0 zoom 1).
function ptr(target: Element, type: string, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  act(() => void target.dispatchEvent(e));
}

describe("BoardBlock connectors UI", () => {
  it("drawing an arrow from shape to shape binds both ends", () => {
    const { doc, id, a, b } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Arrow"]')!.click());
    ptr(svg, "pointerdown", 95, 30);
    ptr(svg, "pointermove", 200, 120);
    ptr(svg, "pointermove", 305, 232);
    expect(el.querySelectorAll(".ocbd-hint circle[data-anchor]")).toHaveLength(5);
    ptr(svg, "pointerup", 305, 232);
    const arrows = shapes(doc, id).filter((s) => s.type === "arrow");
    const made = arrows[arrows.length - 1];
    expect(made.start).toEqual({ shapeId: a, anchor: "right" });
    expect(made.end).toEqual({ shapeId: b, anchor: "left" });
    expect(made.pts).toEqual([[100, 30], [300, 230]]);
    expect(el.querySelector(".ocbd-hint")).toBeNull();
  });

  it("dragging an endpoint onto a shape binds it; dragging it away unbinds", () => {
    const { doc, id, b, ar } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    // select the arrow
    ptr(el.querySelector(`[data-s="${ar}"] path`)!, "pointerdown", 200, 130);
    ptr(svg, "pointerup", 200, 130);
    const head = el.querySelector('circle.ocbd-ep[data-end="end"]')!;
    expect(head).toBeTruthy();
    ptr(head, "pointerdown", 280, 230);
    ptr(svg, "pointermove", 352, 196);
    ptr(svg, "pointerup", 352, 196);
    expect(one(doc, id, ar).end).toEqual({ shapeId: b, anchor: "top" });
    expect(one(doc, id, ar).pts!.at(-1)).toEqual([350, 200]);

    // moving the bound shape by dragging drags the stored arrow too
    ptr(el.querySelector(`[data-s="${b}"] rect`)!, "pointerdown", 350, 230);
    ptr(svg, "pointermove", 450, 230);
    ptr(svg, "pointerup", 450, 230);
    expect(one(doc, id, b).x).toBe(400);
    expect(one(doc, id, ar).pts!.at(-1)).toEqual([450, 200]);

    // drag the head into empty space: unbound
    ptr(el.querySelector(`[data-s="${ar}"] path`)!, "pointerdown", 200, 100);
    ptr(svg, "pointerup", 200, 100);
    ptr(el.querySelector('circle.ocbd-ep[data-end="end"]')!, "pointerdown", 450, 200);
    ptr(svg, "pointermove", 700, 600);
    ptr(svg, "pointerup", 700, 600);
    expect(one(doc, id, ar).end).toBeUndefined();
    expect(one(doc, id, ar).pts!.at(-1)).toEqual([700, 600]);
  });

  it("toggles elbow / straight from the shape toolbar", () => {
    const { doc, id, ar } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const svg = el.querySelector("svg.ocbd-svg")!;
    ptr(el.querySelector(`[data-s="${ar}"] path`)!, "pointerdown", 200, 130);
    ptr(svg, "pointerup", 200, 130);
    const elbowBtn = el.querySelector<HTMLButtonElement>('[aria-label="Elbow connector"]')!;
    expect(el.querySelector('[aria-label="Straight connector"]')!.getAttribute("aria-pressed")).toBe("true");
    act(() => elbowBtn.click());
    expect(one(doc, id, ar).route).toBe("elbow");
    expect(resolved(doc, id, ar)).toEqual(elbow([120, 30], [280, 230]));
    expect(el.querySelector('[aria-label="Elbow connector"]')!.getAttribute("aria-pressed")).toBe("true");
    const d = el.querySelector(`[data-s="${ar}"] path`)!.getAttribute("d")!;
    expect(d.split("L")).toHaveLength(4);
  });
});

/* ------------------------------------------------------------ images */

describe("images", () => {
  beforeEach(() => {
    // jsdom does not decode images; report a 800x400 picture.
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 400;
      decoding = "";
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
  });

  it("fitImage keeps the aspect and never enlarges", () => {
    expect(fitImage(800, 400)).toEqual([360, 180]);
    expect(fitImage(100, 50)).toEqual([100, 50]);
  });

  it("imageSource prefers env.upload, falls back to a data URL, caps at 2 MB", async () => {
    const small = new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
    expect(await imageSource(small, async () => ({ url: "https://cdn.example/a.png" }))).toBe("https://cdn.example/a.png");
    expect(await imageSource(small)).toMatch(/^data:image\/png;base64,/);
    const big = new File([new Uint8Array(MAX_INLINE_IMAGE + 1)], "big.png", { type: "image/png" });
    await expect(imageSource(big)).rejects.toBeInstanceOf(ImageError);
    await expect(imageSource(new File(["x"], "a.txt", { type: "text/plain" }))).rejects.toBeInstanceOf(ImageError);
    await expect(imageSource(small, async () => Promise.reject(new Error("503")))).rejects.toThrow(/upload/);
  });

  it("dropping an image file adds an image shape via env.upload", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const upload = vi.fn(async () => ({ url: "https://cdn.example/pic.png" }));
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env("edit", { upload })} />);
    const file = new File([new Uint8Array(10)], "pic.png", { type: "image/png" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { clientX: 200, clientY: 150, dataTransfer: { files: [file], items: [], types: ["Files"] } });
    await act(async () => {
      el.querySelector(".ocbd")!.dispatchEvent(drop);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(upload).toHaveBeenCalledWith(file);
    const img = shapes(doc, id).find((s) => s.type === "image")!;
    expect(img).toMatchObject({ src: "https://cdn.example/pic.png", w: 360, h: 180, x: 20, y: 60, alt: "pic.png" });
    expect(el.querySelector(`[data-s="${img.id}"] image`)!.getAttribute("href")).toBe("https://cdn.example/pic.png");
  });

  it("pasting an image without env.upload stores a data URL; too-big images toast", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    const paste = (f: File) => {
      const e = new Event("paste", { bubbles: true, cancelable: true });
      Object.assign(e, { clipboardData: { files: [f], items: [], types: ["Files"] } });
      return e;
    };
    await act(async () => {
      el.querySelector(".ocbd")!.dispatchEvent(paste(new File([new Uint8Array(4)], "s.png", { type: "image/png" })));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(shapes(doc, id).find((s) => s.type === "image")!.src).toMatch(/^data:image\/png/);
    toasts.length = 0;
    await act(async () => {
      el.querySelector(".ocbd")!.dispatchEvent(paste(new File([new Uint8Array(MAX_INLINE_IMAGE + 10)], "b.png", { type: "image/png" })));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(shapes(doc, id).filter((s) => s.type === "image")).toHaveLength(1);
    expect(toasts[0]).toMatch(/2 MB/);
  });

  it("viewers cannot drop images", async () => {
    const doc = new Y.Doc();
    const id = createBoard(doc, "blank");
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env("view")} />);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { clientX: 1, clientY: 1, dataTransfer: { files: [new File(["x"], "p.png", { type: "image/png" })], items: [], types: ["Files"] } });
    await act(async () => {
      el.querySelector(".ocbd")!.dispatchEvent(drop);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(shapes(doc, id)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ export */

describe("export", () => {
  it("exportBoardSvg fits the content and uses the light palette", () => {
    const { doc, id, a, b, ar } = fixture();
    updateShape(doc, id, ar, { start: { shapeId: a, anchor: "right" }, end: { shapeId: b, anchor: "left" } });
    addShape(doc, id, { type: "sticky", x: 0, y: 300, w: 150, h: 110, fill: "y", text: "Hi <there> & you" });
    addShape(doc, id, { type: "image", x: 500, y: 0, w: 40, h: 40, src: "data:image/png;base64,AAAA" });
    const svg = exportBoardSvg(doc, id);
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    const root = parsed.documentElement;
    expect(root.getAttribute("viewBox")).toBe("-32 -32 604 474");
    expect(svg).not.toContain("var(--");
    expect(svg).toContain("#fdeaa0");
    expect(svg).toContain("Hi &lt;there&gt; &amp; you");
    expect(svg).toContain('d="M100 30 L300 230"');
    expect(root.querySelector("image")!.getAttribute("href")).toBe("data:image/png;base64,AAAA");
  });

  it("exportBoardSvg of an empty or missing board is a blank page", () => {
    const doc = new Y.Doc();
    expect(exportBoardSvg(doc, createBoard(doc))).toContain('viewBox="0 0 320 200"');
    expect(exportBoardSvg(doc, "nope")).toContain("<svg");
  });

  it("exportBoardPng draws the SVG at the given scale", async () => {
    const { doc, id } = fixture();
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = "";
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const drawn: number[][] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect: () => {}, set fillStyle(_v: string) {}, drawImage: (_i: unknown, ...a: number[]) => void drawn.push(a) }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["png"], { type: "image/png" })),
    };
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((t: string) => (t === "canvas" ? canvas : orig(t))) as typeof document.createElement);
    const blob = await exportBoardPng(doc, id, 3);
    expect(blob.type).toBe("image/png");
    expect([canvas.width, canvas.height]).toEqual([464 * 3, 324 * 3]);
    expect(drawn[0]).toEqual([0, 0, 464 * 3, 324 * 3]);
  });

  it("board menu offers export (and image insert for editors)", () => {
    const { doc, id } = fixture();
    const el = mount(<BoardBlock doc={doc} boardId={id} env={env()} />);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Board options"]')!.click());
    const items = [...el.querySelectorAll(".ocbd-menu [role=menuitem]")].map((b) => b.textContent);
    expect(items).toEqual(["Insert image", "Export as PNG", "Export as SVG"]);
    cleanup?.();
    document.body.innerHTML = "";
    const v = mount(<BoardBlock doc={doc} boardId={id} env={env("view")} />);
    act(() => v.querySelector<HTMLButtonElement>('[aria-label="Board options"]')!.click());
    expect([...v.querySelectorAll(".ocbd-menu [role=menuitem]")].map((b) => b.textContent)).toEqual(["Export as PNG", "Export as SVG"]);
  });
});
