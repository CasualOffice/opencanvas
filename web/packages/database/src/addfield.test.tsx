// @vitest-environment jsdom
// Adding a field (highlight, naming in place, Escape discards), insert left / right, and field
// descriptions (shared, tooltip, peek, Markdown). docs/20-BLOCKS-UX-AUDIT.md D28–D31.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "./index";
import { createDatabase, databaseToMarkdown, getDbMap, readDb, setFieldDescription } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: string[] = [];
const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users: [], toast: (m) => void toasts.push(m) });
const snap = (doc: Y.Doc, id: string) => readDb(id, getDbMap(doc, id)!);

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  toasts.length = 0;
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
const click = (el: Element) => act(() => (el as HTMLElement).click());
const key = (el: Element | Document, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const byText = (sel: string, text: RegExp) => [...document.querySelectorAll<HTMLElement>(sel)].find((b) => text.test(b.textContent ?? ""))!;

function table() {
  const doc = new Y.Doc();
  const id = createDatabase(doc, "tasks");
  const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
  return { doc, id, el };
}

describe("adding a field", () => {
  it("highlights the new column, then clears the highlight", () => {
    vi.useFakeTimers();
    const { doc, id, el } = table();
    const add = el.querySelector<HTMLButtonElement>('th.ocdb-addcol button[aria-label="Add a field"]')!;
    expect(add.title).toBe("Add a field");
    click(add);
    const fid = snap(doc, id).fields.at(-1)!.id;
    const mark = el.querySelector<HTMLElement>(".ocdb-colmark.flash")!;
    expect(mark.getAttribute("data-fid")).toBe(fid);
    act(() => void vi.advanceTimersByTime(1300));
    expect(el.querySelector(".ocdb-colmark.flash")).toBeNull();
  });

  it("opens the name selected with the type picker next to it; Enter keeps it and focus returns to the header", () => {
    const { doc, id, el } = table();
    click(el.querySelector('th.ocdb-addcol button')!);
    const name = document.activeElement as HTMLInputElement;
    expect(name.getAttribute("aria-label")).toBe("Field name");
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, name.value.length]);
    expect(document.querySelector('.ocdb-pop [role="radiogroup"][aria-label="Field type"]')).toBeTruthy();
    // Picking a type renames a name nobody typed, then the typed name wins.
    click(document.querySelector('.ocdb-pop [role="radio"][data-t="number"]')!);
    expect(name.value).toBe("Number");
    type(name, "Estimate");
    key(name, "Enter");
    const f = snap(doc, id).fields.at(-1)!;
    expect([f.name, f.type]).toEqual(["Estimate", "number"]);
    expect(document.querySelector(".ocdb-pop")).toBeNull();
    expect((document.activeElement as HTMLElement).closest("th")?.getAttribute("data-fid")).toBe(f.id);
    expect(el.querySelector(`th[data-fid="${f.id}"]`)).toBeTruthy();
  });

  it("Escape on a brand-new field removes it again", () => {
    const { doc, id, el } = table();
    const n = snap(doc, id).fields.length;
    click(el.querySelector('th.ocdb-addcol button')!);
    expect(snap(doc, id).fields).toHaveLength(n + 1);
    key(document.activeElement!, "Escape");
    expect(snap(doc, id).fields).toHaveLength(n);
    expect(document.querySelector(".ocdb-pop")).toBeNull();
    expect(document.activeElement).toBe(el.querySelector("th.ocdb-addcol button"));
  });

  it("inserts left or right of a column from its menu, for this view", () => {
    const { doc, id, el } = table();
    click(el.querySelector('th[data-fid="due"] .ocdb-hcell')!);
    click(byText(".ocdb-pop .ocdb-mi", /^Insert left$/));
    const fid = snap(doc, id).fields.at(-1)!.id;
    key(document.activeElement!, "Enter");
    const order = snap(doc, id).views.table.fields!;
    expect(order.indexOf(fid)).toBe(order.indexOf("due") - 1);
    const heads = [...el.querySelectorAll("thead th[data-fid]")].map((th) => th.getAttribute("data-fid"));
    expect(heads.indexOf(fid)).toBe(heads.indexOf("due") - 1);
  });
});

describe("selected cell", () => {
  it("gets focus back when its editor closes, so the selection ring stays on it", () => {
    const { el } = table();
    const cell = el.querySelector<HTMLButtonElement>("td[data-r='1'][data-c='1'] button")!;
    act(() => cell.focus());
    click(cell);
    expect(document.querySelector(".ocdb-pop")).toBeTruthy();
    key(document, "Escape");
    expect(document.querySelector(".ocdb-pop")).toBeNull();
    expect(document.activeElement).toBe(cell);
  });
});

describe("inside the editor", () => {
  it("handles Ctrl+Z when it sits in a contenteditable document", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    document.body.appendChild(host);
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "false");
    host.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<DatabaseBlock doc={doc} dbId={id} env={env()} />));
    cleanup = () => act(() => root.unmount());
    const was = snap(doc, id).rows[0].v.status;
    const cell = el.querySelector<HTMLButtonElement>("td[data-r='0'][data-c='1'] button")!;
    click(cell);
    click(byText(".ocdb-pop .ocdb-mi", /^Backlog/));
    key(cell, "z", { ctrlKey: true });
    expect(snap(doc, id).rows[0].v.status).toBe(was);
  });
});

describe("field descriptions", () => {
  it("round-trip through the shared field map, across two docs", () => {
    const a = new Y.Doc(), b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
    const id = createDatabase(a, "tasks");
    setFieldDescription(a, id, "pts", "Story points.\nFibonacci only.");
    expect(snap(b, id).fields.find((f) => f.id === "pts")!.description).toBe("Story points.\nFibonacci only.");
    expect((getDbMap(b, id)!.get("fields") as Y.Array<Y.Map<unknown>>).get(4).get("description")).toBe("Story points.\nFibonacci only.");
    setFieldDescription(a, id, "pts", "  ");
    expect(snap(b, id).fields.find((f) => f.id === "pts")!.description).toBeUndefined();
  });

  it("is edited from the column menu and shown as a header tooltip with an accessible description", () => {
    const { doc, id, el } = table();
    click(el.querySelector('th[data-fid="pts"] .ocdb-hcell')!);
    click(byText(".ocdb-pop .ocdb-mi", /^Add a description$/));
    const ta = document.querySelector<HTMLTextAreaElement>('.ocdb-pop textarea[aria-label="Description of Points"]')!;
    type(ta, "Story points, Fibonacci only");
    click(byText(".ocdb-pop button", /^Save$/));
    expect(snap(doc, id).fields.find((f) => f.id === "pts")!.description).toBe("Story points, Fibonacci only");
    const head = el.querySelector('th[data-fid="pts"] .ocdb-hcell')!;
    const tip = document.getElementById(head.getAttribute("aria-describedby")!)!;
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toBe("Story points, Fibonacci only");
    const info = el.querySelector<HTMLButtonElement>('th[data-fid="pts"] .ocdb-hinfo')!;
    expect(info.getAttribute("aria-label")).toBe("About Points");
    expect(info.getAttribute("aria-describedby")).toBe(tip.id);
    expect(document.activeElement).toBe(head);
  });

  it("Escape cancels an edit; the peek shows the note; Markdown lists it under the table", () => {
    const { doc, id, el } = table();
    act(() => setFieldDescription(doc, id, "due", "When it ships"));
    click(el.querySelector('th[data-fid="due"] .ocdb-hcell')!);
    click(byText(".ocdb-pop .ocdb-mi", /^Edit description$/));
    type(document.querySelector<HTMLTextAreaElement>(".ocdb-pop textarea")!, "changed");
    key(document, "Escape");
    expect(snap(doc, id).fields.find((f) => f.id === "due")!.description).toBe("When it ships");
    click(el.querySelectorAll<HTMLButtonElement>(".ocdb-peekbtn")[0]);
    expect(document.querySelector(".ocdb-side .ocdb-pdesc")!.textContent).toBe("When it ships");
    expect(databaseToMarkdown(snap(doc, id))).toMatch(/\| Integration guide[^\n]*\n\n\*Due\*: When it ships$/);
  });
});
