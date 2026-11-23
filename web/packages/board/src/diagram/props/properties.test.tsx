// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// DGM-14 S4: the properties panel (approved prototype 4a-4d).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addShape, createBoard, readShapes, getBoardMap, type Shape } from "../../model";
import { Properties } from "./Properties";
import { MIXED, moveItem, moveTo, setProp, shared } from "./fields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("panel helpers", () => {
  it("shares a value or reports Mixed", () => {
    const a = { id: "a", type: "rect", fill: "blue" } as Shape, b = { id: "b", type: "rect", fill: "green" } as Shape;
    expect(shared([a, { ...a, id: "c" }], (s) => s.fill)).toBe("blue");
    expect(shared([a, b], (s) => s.fill)).toBe(MIXED);
  });
  it("reorders rows by one step and by drag", () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveTo([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
  });
  it("merges concurrent edits of different props fields of one shape", () => {
    const a = new Y.Doc(), b = new Y.Doc();
    const bid = createBoard(a, "blank");
    const id = addShape(a, bid, { type: "rect", kind: "uml:class", x: 0, y: 0, w: 100, h: 80, text: "Order", props: { stereotype: "" } });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    setProp(a, bid, [id], "stereotype", "aggregate root");
    setProp(b, bid, [id], "abstract", true);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) expect(readShapes(getBoardMap(d, bid)!).find((s) => s.id === id)!.props).toEqual({ stereotype: "aggregate root", abstract: true });
  });
});

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  document.body.innerHTML = "";
});
function setup(shapes: Omit<Shape, "id">[], pick: number[], edit = true) {
  const doc = new Y.Doc();
  const bid = createBoard(doc, "blank");
  const ids = shapes.map((s) => addShape(doc, bid, s));
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = () => {
    const all = readShapes(getBoardMap(doc, bid)!);
    act(() => root.render(<Properties doc={doc} boardId={bid} selected={pick.map((i) => all.find((s) => s.id === ids[i])!)} shapes={all} edit={edit} />));
  };
  render();
  doc.on("update", render);
  cleanups.push(() => act(() => root.unmount()));
  const get = (i: number) => readShapes(getBoardMap(doc, bid)!).find((s) => s.id === ids[i])!;
  return { el, doc, bid, ids, get };
}
const input = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLInputElement>("input")].find((i) => i.getAttribute("aria-label") === label || i.closest("label")?.querySelector(".ocdg-lbl")?.textContent === label)!;
function type(i: HTMLInputElement, v: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(i, v);
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    i.focus();
    i.blur();
  });
}

const umlClass: Omit<Shape, "id"> = {
  type: "rect", kind: "uml:class", x: 0, y: 0, w: 160, h: 120, text: "Order",
  props: { attributes: [{ vis: "-", name: "id", type: "OrderId" }, { vis: "-", name: "status", type: "OrderStatus" }], methods: [{ vis: "+", name: "submit()", type: "void" }] },
};

describe("properties panel", { timeout: 30_000 }, () => {
  it("edits a UML class: stereotype and abstract are separate props keys", () => {
    const { el, get } = setup([umlClass], [0]);
    expect(el.querySelector(".ocpp-kind")!.textContent).toBe("Class · UML");
    type(input(el, "Stereotype"), "«aggregate root»");
    expect(get(0).props!.stereotype).toBe("aggregate root");
    act(() => el.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(get(0).props!.abstract).toBe(true);
    expect(get(0).props!.attributes).toHaveLength(2);
  });
  it("reorders attributes with Alt+ArrowDown and edits a row", () => {
    const { el, get } = setup([umlClass], [0]);
    const row = el.querySelector<HTMLElement>('ul[aria-label="Attributes"] li')!;
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })));
    expect((get(0).props!.attributes as { name: string }[]).map((a) => a.name)).toEqual(["status", "id"]);
    type(el.querySelectorAll<HTMLInputElement>('input[aria-label="Attribute type"]')[0]!, "Status");
    expect((get(0).props!.attributes as { type: string }[])[0]!.type).toBe("Status");
    act(() => [...el.querySelectorAll<HTMLButtonElement>(".ocpp-add")].find((b) => b.textContent!.includes("attribute"))!.click());
    expect(get(0).props!.attributes).toHaveLength(3);
  });
  it("ERD entity: a foreign key asks what it references; relationships are listed", () => {
    const { el, get } = setup(
      [
        { type: "rect", kind: "erd:entity", x: 0, y: 0, w: 160, h: 120, text: "orders", props: { columns: [{ key: "", name: "customer_id", type: "uuid" }] } },
        { type: "rect", kind: "erd:entity", x: 300, y: 0, w: 160, h: 120, text: "customers" },
      ],
      [0],
    );
    act(() => el.querySelector<HTMLButtonElement>(".ocpp-key")!.click());
    act(() => el.querySelector<HTMLButtonElement>(".ocpp-key")!.click());
    expect((get(0).props!.columns as { key: string }[])[0]!.key).toBe("fk");
    type(input(el, "References"), "customers.id");
    expect((get(0).props!.columns as { ref: string }[])[0]!.ref).toBe("customers.id");
    act(() => el.querySelector<HTMLInputElement>('.ocpp-cb input')!.click());
    expect((get(0).props!.columns as { nullable: boolean }[])[0]!.nullable).toBe(true);
  });
  it("network node: changing the kind keeps name, colour and connections", () => {
    const { el, get } = setup(
      [
        { type: "rect", kind: "network:service", x: 0, y: 0, w: 150, h: 56, text: "Payments service", fill: "green", props: { detail: "Java" } },
        { type: "rect", kind: "network:database", x: 300, y: 0, w: 150, h: 56, text: "payments-db" },
      ],
      [0],
    );
    const sel = el.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      sel.value = "network:server";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const s = get(0);
    expect(s.kind).toBe("network:server");
    expect(s.text).toBe("Payments service");
    expect(s.fill).toBe("green");
    expect(s.props).toEqual({ detail: "Java" });
  });
  it("connector: route, avoid shapes, cardinality for ERD and a label", () => {
    const doc0: Omit<Shape, "id">[] = [
      { type: "rect", kind: "erd:entity", x: 0, y: 0, w: 100, h: 60, text: "customers" },
      { type: "rect", kind: "erd:entity", x: 300, y: 0, w: 100, h: 60, text: "orders" },
    ];
    const { el, doc, bid, ids, get } = setup(doc0, [0]);
    void el;
    const cid = addShape(doc, bid, { type: "arrow", pts: [[100, 30], [300, 30]], start: { shapeId: ids[0]!, anchor: "right" }, end: { shapeId: ids[1]!, anchor: "left" } });
    const all = readShapes(getBoardMap(doc, bid)!);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const r = () => act(() => root.render(<Properties doc={doc} boardId={bid} selected={[readShapes(getBoardMap(doc, bid)!).find((s) => s.id === cid)!]} shapes={readShapes(getBoardMap(doc, bid)!)} edit />));
    r();
    doc.on("update", r);
    cleanups.push(() => act(() => root.unmount()));
    void all; void get;
    expect(host.querySelector(".ocpp-kind")!.textContent).toBe("Relationship");
    expect(host.querySelector(".ocpp-ends")!.textContent).toContain("customers · right");
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((b) => b.textContent!.includes("Avoid"))!.click());
    const c = () => readShapes(getBoardMap(doc, bid)!).find((s) => s.id === cid)!;
    expect([c().route, c().routing]).toEqual(["elbow", "avoid"]);
    const end = [...host.querySelectorAll<HTMLSelectElement>("select")][1]!;
    act(() => {
      end.value = "many";
      end.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(c().props).toEqual({ endCard: "many" });
    type(input(host, "Text"), "places");
    expect(c().text).toBe("places");
  });
  it("multi-select shows Mixed and writes to every shape", () => {
    const { el, get } = setup(
      [
        { type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "blue" },
        { type: "rect", x: 20, y: 0, w: 10, h: 10, fill: "green" },
      ],
      [0, 1],
    );
    expect(el.querySelector(".ocpp-title")!.textContent).toBe("2 selected");
    const colour = input(el, "Colour");
    expect(colour.placeholder).toBe("Mixed");
    type(colour, "pink");
    expect([get(0).fill, get(1).fill]).toEqual(["pink", "pink"]);
  });
  it("view only: fields are read only and lists have no add or remove", () => {
    const { el } = setup([umlClass], [0], false);
    expect(input(el, "Stereotype").readOnly).toBe(true);
    expect(el.querySelector(".ocpp-add")).toBeNull();
    expect(el.querySelector(".ocpp-grip")).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
  });
  it("mounts in the diagram shell when something is selected", async () => {
    const { default: Shell } = await import("../Shell");
    const doc = new Y.Doc();
    const bid = createBoard(doc, "blank");
    const id = addShape(doc, bid, umlClass);
    const s = readShapes(getBoardMap(doc, bid)!).find((x) => x.id === id)!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const env = { role: "edit" as const, compact: false, me: { id: "p", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: () => {} };
    act(() =>
      root.render(
        <Shell doc={doc} boardId={bid} env={env} anchor={() => null} place={{ heading: "", title: "" }} closing={false} onClosed={() => {}} onBack={() => {}} peers={[]} undo={{ can: false, run: () => {} }} redo={{ can: false, run: () => {} }} menuOpen={false} onMenu={() => {}} origin={null} prefs={{ grid: true, gridSize: 20, rulers: true, snapGrid: true, snapShapes: true, connector: "elbow" }} onPrefs={() => {}} selected={[s]} shapes={[s]}>
          <div />
        </Shell>,
      ),
    );
    cleanups.push(() => act(() => root.unmount()));
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Properties"] .ocpp-title')!.textContent).toBe("Order"), { timeout: 10_000 });
  });
});
