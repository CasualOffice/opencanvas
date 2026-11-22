// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Open items from docs/20-BLOCKS-UX-AUDIT.md: typed filters (D21), per-view fields (D22),
// calendar drag + tray + double-click (D23), header count (docs/19 #43), shared undo manager.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "./index";
import { addField, createDatabase, getDbMap, readDb, setCell, setPrefs, setView } from "./model";
import { filterLabel, filtersOf, orderedFields, rulesOf, viewFields, visibleRows } from "./query";
import { CSS } from "./styles";
import type { FilterRule } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const users = [{ id: "asha", name: "Asha Rao", color: "#7a45f0" }, { id: "ravi", name: "Ravi Menon", color: "#e5602a" }];
const toasts: string[] = [];
const env = (extra: Partial<BlockEnv> = {}): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users, toast: (m) => void toasts.push(m), ...extra });
const snap = (doc: Y.Doc, id: string) => readDb(id, getDbMap(doc, id)!);
const NOW = new Date(2026, 10, 21, 12);

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
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
const click = (el: Element) => act(() => (el as HTMLElement).click());
const byText = <T extends Element>(root: ParentNode, sel: string, text: string | RegExp) =>
  [...root.querySelectorAll<T>(sel)].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
function ptr(target: Element, type: string, x: number, y: number, o: { pointerType?: string; pointerId?: number } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, "pointerId", { value: o.pointerId ?? 1 });
  Object.defineProperty(e, "pointerType", { value: o.pointerType ?? "mouse" });
  act(() => void target.dispatchEvent(e));
}

/* ------------------------------------------------------------ D21 */

describe("typed filters", () => {
  const titles = (rules: FilterRule[], doc: Y.Doc, id: string) => visibleRows(snap(doc, id), { filters: rules }, users, NOW).map((r) => r.v.title);

  it("text: contains, is, is empty (case-insensitive)", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    expect(titles([{ f: "title", op: "contains", v: "board" }], doc, id)).toEqual(["Database block: table and board views", "Board pointer smoothing at 60 fps"]);
    expect(titles([{ f: "title", op: "is", v: "side-panel layout for meet" }], doc, id)).toEqual(["Side-panel layout for Meet"]);
    const notes = addField(doc, id, "text", "Notes");
    const first = snap(doc, id).rows[0].id;
    setCell(doc, id, first, notes, "has notes");
    expect(titles([{ f: notes, op: "empty" }], doc, id)).toHaveLength(6);
    // An unfinished rule (no value yet) changes nothing.
    expect(titles([{ f: "title", op: "contains", v: "" }], doc, id)).toHaveLength(7);
  });

  it("number: = ≠ < ≤ > ≥ and between", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const pts = (op: FilterRule["op"], v: number, v2?: number) => visibleRows(snap(doc, id), { filters: [{ f: "pts", op, v, v2 }] }, users, NOW).map((r) => r.v.pts);
    expect(pts("eq", 3)).toEqual([3, 3, 3]);
    expect(pts("ne", 3)).toEqual([2, 5, 8, 2]);
    expect(pts("lt", 3)).toEqual([2, 2]);
    expect(pts("le", 3)).toEqual([2, 3, 3, 3, 2]);
    expect(pts("gt", 3)).toEqual([5, 8]);
    expect(pts("ge", 5)).toEqual([5, 8]);
    expect(pts("between", 3, 5)).toEqual([3, 5, 3, 3]);
    expect(pts("between", 5, 3)).toEqual([3, 5, 3, 3]);
  });

  it("date: is, before, after, within the next / past N days, is empty", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const due = (rule: Omit<FilterRule, "f">) => visibleRows(snap(doc, id), { filters: [{ f: "due", ...rule }] }, users, NOW).map((r) => r.v.due);
    expect(due({ op: "is", v: "2026-11-24" })).toEqual(["2026-11-24"]);
    expect(due({ op: "before", v: "2026-11-24" })).toEqual(["2026-11-17"]);
    expect(due({ op: "after", v: "2026-11-27" })).toEqual(["2026-12-02", "2026-12-04"]);
    // Today is 2026-11-21: the next 5 days run to the 26th, inclusive.
    expect(due({ op: "next", v: 5 })).toEqual(["2026-11-24", "2026-11-26", "2026-11-25"]);
    expect(due({ op: "past", v: 7 })).toEqual(["2026-11-17"]);
    setCell(doc, id, snap(doc, id).rows[0].id, "due", null);
    expect(due({ op: "empty" })).toEqual([null]);
  });

  it("checkbox and option filters keep their value lists; all rules combine with AND", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const done = addField(doc, id, "checkbox", "Shipped");
    setCell(doc, id, snap(doc, id).rows[1].id, done, true);
    setCell(doc, id, snap(doc, id).rows[2].id, done, true);
    expect(titles([{ f: done, vals: ["true"] }], doc, id)).toHaveLength(2);
    expect(titles([{ f: done, vals: ["true"] }, { f: "pts", op: "gt", v: 3 }], doc, id)).toEqual(["Room WAL compaction every 500 updates"]);
    expect(titles([{ f: "status", vals: ["Backlog"] }, { f: "title", op: "contains", v: "guide" }], doc, id)).toEqual(["Integration guide: callbacks section"]);
  });

  it("keeps unfinished rules for the editor but only applies finished ones, and labels chips", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const db = snap(doc, id);
    const prefs = { filters: [{ f: "title", op: "contains", v: "" }, { f: "pts", op: "between", v: 2, v2: 5 }, { f: "gone", op: "is", v: "x" }] as FilterRule[] };
    expect(rulesOf(db, prefs)).toHaveLength(2);
    expect(filtersOf(db, prefs)).toEqual([prefs.filters[1]]);
    const f = (fid: string) => db.fields.find((x) => x.id === fid)!;
    expect(filterLabel(f("pts"), { f: "pts", op: "between", v: 2, v2: 5 })).toBe("Points between 2 and 5");
    expect(filterLabel(f("pts"), { f: "pts", op: "ge", v: 3 })).toBe("Points ≥ 3");
    expect(filterLabel(f("title"), { f: "title", op: "contains", v: "api" })).toBe("Task contains “api”");
    expect(filterLabel(f("due"), { f: "due", op: "next", v: 7 })).toBe("Due within the next 7 days");
    expect(filterLabel(f("due"), { f: "due", op: "before", v: "2026-11-24" })).toBe("Due before Nov 24");
    expect(filterLabel(f("due"), { f: "due", op: "empty" })).toBe("Due is empty");
    expect(filterLabel(f("status"), { f: "status", vals: ["Done", ""] })).toBe("Status: Done, Empty");
  });

  it("builds a typed rule from the Filter popover and shows it as a removable chip", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    click(el.querySelector('[aria-label="Filter"]')!);
    const pop = document.querySelector(".ocdb-pop")!;
    click(byText(pop, "button", /^Points/)!);
    const op = document.querySelector<HTMLSelectElement>('.ocdb-pop select[aria-label="Points condition"]')!;
    type(op, "gt");
    type(document.querySelector<HTMLInputElement>('.ocdb-pop input[aria-label="Points value"]')!, "4");
    // Shared through the view settings.
    expect(snap(doc, id).views.table.filters).toEqual([{ f: "pts", op: "gt", v: 4 }]);
    expect(el.querySelectorAll("tbody tr[data-row]")).toHaveLength(2);
    const chip = el.querySelector(".ocdb-chips .ocdb-chip")!;
    expect(chip.textContent).toContain("Points > 4");
    click(chip.querySelector('[aria-label="Remove filter Points > 4"]')!);
    expect(snap(doc, id).views.table.filters).toEqual([]);
    expect(el.querySelectorAll("tbody tr[data-row]")).toHaveLength(7);
  });
});

/* ------------------------------------------------------------ D22 */

describe("fields per view", () => {
  it("orders and hides fields per view; the title is never hidden", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const db = snap(doc, id);
    const prefs = { fields: ["due", "title", "nope"], hidden: ["owner", "title"] };
    expect(orderedFields(db, prefs).map((f) => f.id)).toEqual(["due", "title", "status", "owner", "pts", "area"]);
    expect(viewFields(db, prefs).map((f) => f.id)).toEqual(["due", "title", "status", "pts", "area"]);
  });

  it("toggles and reorders columns from the Fields menu, for this view only", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const heads = () => [...el.querySelectorAll("thead th[data-fid]")].map((th) => th.getAttribute("data-fid"));
    click(el.querySelector('[aria-label="Fields"]')!);
    const sw = (name: string) => document.querySelector<HTMLButtonElement>(`.ocdb-pop [role="switch"][aria-label="Show ${name}"]`)!;
    expect(sw("Task").disabled).toBe(true);
    click(sw("Owner"));
    expect(sw("Owner").getAttribute("aria-checked")).toBe("false");
    expect(heads()).not.toContain("owner");
    expect(snap(doc, id).views.table.hidden).toEqual(["owner"]);
    click(document.querySelector('.ocdb-pop [aria-label="Move Due up"]')!);
    expect(heads()).toEqual(["title", "status", "due", "pts", "area"]);
    // The shared field list is untouched; the board view still has every field.
    expect(snap(doc, id).fields.map((f) => f.id)).toEqual(["title", "status", "owner", "due", "pts", "area"]);
    expect(snap(doc, id).views.board?.hidden).toBeUndefined();
  });

  it("column moves from the header change this view's order, not the shared fields", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const head = el.querySelectorAll<HTMLButtonElement>("th .ocdb-hcell")[1];
    key(head, "ArrowRight", { altKey: true, shiftKey: true });
    expect(snap(doc, id).views.table.fields!.slice(0, 3)).toEqual(["title", "owner", "status"]);
    expect(snap(doc, id).fields.map((f) => f.id).slice(0, 3)).toEqual(["title", "status", "owner"]);
    expect(document.activeElement?.closest("th")?.getAttribute("data-fid")).toBe("status");
  });

  it("board cards leave out fields hidden in the board view", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    setView(doc, id, "board");
    setPrefs(doc, id, "board", { hidden: ["owner", "due"] });
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    expect(el.querySelector(".ocdb-kcard .ocdb-av")).toBeNull();
    expect(el.querySelector(".ocdb-kcard .lucide-calendar")).toBeNull();
  });
});

/* ------------------------------------------------------------ D23 */

describe("calendar", () => {
  function calendar(extra: Partial<BlockEnv> = {}) {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    setView(doc, id, "calendar");
    setPrefs(doc, id, "calendar", { cal: "2026-11" });
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env(extra)} />);
    return { doc, id, el };
  }
  const item = (el: Element, title: RegExp) => byText<HTMLButtonElement>(el, ".ocdb-cev", title)!;

  it("moves a focused item with Alt+arrows (a day, or a week) and keeps focus on it", () => {
    const { doc, id, el } = calendar();
    const rid = snap(doc, id).rows[1].id; // due 2026-11-24
    const it0 = item(el, /^Role filter/);
    act(() => it0.focus());
    key(it0, "ArrowRight", { altKey: true });
    expect(snap(doc, id).rows[1].v.due).toBe("2026-11-25");
    key(document.activeElement!, "ArrowDown", { altKey: true });
    expect(snap(doc, id).rows[1].v.due).toBe("2026-12-02");
    expect((document.activeElement as HTMLElement).getAttribute("data-cev")).toBe(rid);
    // The month follows an item moved out of it.
    expect(el.querySelector(".ocdb-calh b")!.textContent).toBe("December 2026");
  });

  it("drags an item to another day with the mouse", () => {
    const { doc, id, el } = calendar();
    const it0 = item(el, /^Role filter/);
    const day = el.querySelector('[data-day="2026-11-12"]')!;
    const efp = vi.fn(() => day);
    Object.defineProperty(document, "elementFromPoint", { value: efp, configurable: true });
    ptr(it0, "pointerdown", 10, 10);
    ptr(window as unknown as Element, "pointermove", 40, 40);
    ptr(window as unknown as Element, "pointermove", 60, 60);
    expect(day.classList.contains("over")).toBe(true);
    ptr(window as unknown as Element, "pointerup", 60, 60);
    expect(snap(doc, id).rows[1].v.due).toBe("2026-11-12");
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("picks an item up on touch after a long press", () => {
    vi.useFakeTimers();
    const { doc, id, el } = calendar();
    const it0 = item(el, /^Role filter/);
    const day = el.querySelector('[data-day="2026-11-19"]')!;
    Object.defineProperty(document, "elementFromPoint", { value: () => day, configurable: true });
    ptr(it0, "pointerdown", 10, 10, { pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(300));
    ptr(window as unknown as Element, "pointermove", 12, 12, { pointerType: "touch" });
    ptr(window as unknown as Element, "pointerup", 12, 12, { pointerType: "touch" });
    expect(snap(doc, id).rows[1].v.due).toBe("2026-11-19");
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("lists rows without a date in a tray; Alt+arrows schedule them", () => {
    const { doc, id, el } = calendar();
    act(() => setCell(doc, id, snap(doc, id).rows[0].id, "due", null));
    const tray = el.querySelector(".ocdb-tray")!;
    expect(tray.textContent).toContain("No date");
    const t = byText<HTMLButtonElement>(tray, "[data-cev]", /^Launch-token/)!;
    act(() => t.focus());
    key(t, "ArrowRight", { altKey: true });
    // Today when it is in the month shown, else the month's first day.
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(snap(doc, id).rows[0].v.due).toBe(iso.startsWith("2026-11") ? iso : "2026-11-01");
    expect(el.querySelector(".ocdb-tray [data-cev]")).toBeNull();
  });

  it("creates an item when a day is double-clicked", () => {
    const { doc, id, el } = calendar();
    const n = snap(doc, id).rows.length;
    act(() => void el.querySelector('[data-day="2026-11-10"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const rows = snap(doc, id).rows;
    expect(rows).toHaveLength(n + 1);
    expect(rows.at(-1)!.v.due).toBe("2026-11-10");
    expect(document.querySelector(".ocdb-side")).toBeTruthy();
  });
});

/* ------------------------------------------------------- docs/19 #43 */

describe("header", () => {
  it("keeps the row count outside the name field so it never sits under the hover chrome", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    // The editor's block handle sits at the text column's left edge, which for a wide block is
    // inside the header, right after a short name. The count is pushed to the far right.
    const count = el.querySelector(".ocdb-h > .ocdb-hc")!;
    expect(count.textContent).toBe("7 rows");
    expect(CSS).toMatch(/\.ocdb-hc\{[^}]*margin-left:auto/);
  });
});

/* ------------------------------------------------------ shared undo */

describe("shared undo manager", () => {
  it("records database edits in the editor's UndoManager when one is passed", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const um = new Y.UndoManager(doc.getXmlFragment("content"), { captureTimeout: 0 });
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env({ undoManager: um })} />);
    const was = snap(doc, id).rows[0].v.status;
    const cell = el.querySelector<HTMLButtonElement>("td[data-r='0'][data-c='1'] button")!;
    click(cell);
    click(byText(document, ".ocdb-pop .ocdb-mi", /^Backlog/)!);
    expect(snap(doc, id).rows[0].v.status).toBe("Backlog");
    expect(um.undoStack.length).toBe(1);
    act(() => void um.undo());
    expect(snap(doc, id).rows[0].v.status).toBe(was);
    // Ctrl+Z in the block goes through the same manager.
    act(() => void um.redo());
    key(cell, "z", { ctrlKey: true });
    expect(snap(doc, id).rows[0].v.status).toBe(was);
    expect(um.redoStack.length).toBe(1);
  });
});
