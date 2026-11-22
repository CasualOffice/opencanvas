// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv, OcUser, Role } from "@opencanvas/ui";
import { DatabaseBlock } from "./index";
import { createDatabase, getDbMap, moveRow, presetPeopleMap, readDb, setView } from "./model";
import { DB_PRESETS, DEMO_PEOPLE } from "./presets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snap = (doc: Y.Doc, id: string) => readDb(id, getDbMap(doc, id)!);
const titles = (doc: Y.Doc, id: string) => snap(doc, id).rows.map((r) => r.v.title);
const statusOf = (doc: Y.Doc, id: string, title: string) => snap(doc, id).rows.find((r) => r.v.title === title)!.v.status;
const env = (role: Role = "edit", compact = false, users: OcUser[] = []): BlockEnv => ({
  role,
  compact,
  me: { id: "me1", name: "Mina Park", color: "#2a5ad7" },
  users,
  toast: () => {},
});
const REAL: OcUser[] = [
  { id: "u-ana", name: "Ana Lima", color: "#2a5ad7" },
  { id: "u-bo", name: "Bo Chen", color: "#7a45f0" },
];

/* ------------------------------------------------------------ model */

describe("preset people", () => {
  it("keeps the old sample ids when no users are given", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const owners = snap(doc, id).rows.map((r) => r.v.owner).filter(Boolean);
    expect(owners.every((o) => DEMO_PEOPLE.some((d) => d.id === o))).toBe(true);
  });

  it.each(DB_PRESETS)("%s: maps sample people onto real users only", (p) => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, p, REAL);
    const db = snap(doc, id);
    for (const f of db.fields.filter((f) => f.type === "person"))
      for (const r of db.rows) expect([null, "u-ana", "u-bo"]).toContain(r.v[f.id] ?? null);
  });

  it("is deterministic, wraps, keeps known ids, and empties with no users", () => {
    const m = presetPeopleMap(REAL);
    expect([...m.entries()]).toEqual([["priya", "u-ana"], ["asha", "u-bo"], ["ravi", "u-ana"], ["lin", "u-bo"]]);
    expect([...presetPeopleMap(REAL).entries()]).toEqual([...m.entries()]);
    const withRavi = presetPeopleMap([{ id: "ravi", name: "Ravi", color: "" }, ...REAL]);
    expect(withRavi.get("ravi")).toBe("ravi");
    expect(withRavi.get("priya")).toBe("u-ana");
    expect([...presetPeopleMap([]).values()]).toEqual([null, null, null, null]);
    const doc = new Y.Doc();
    const id = createDatabase(doc, "kanban", []);
    expect(snap(doc, id).rows.every((r) => r.v.owner === null)).toBe(true);
  });

  it("shows real names, not sample names, on cards", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "kanban", REAL);
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env("edit", false, REAL)} />);
    expect(el.textContent).toContain("Ana");
    for (const d of DEMO_PEOPLE) expect(el.textContent).not.toContain(d.name.split(" ")[0]);
  });
});

describe("moveRow", () => {
  it("moves before a row, or to the end", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "kanban");
    const [a, b, c, d] = snap(doc, id).rows.map((r) => r.id);
    moveRow(doc, id, d, a);
    expect(snap(doc, id).rows.map((r) => r.id)).toEqual([d, a, b, c]);
    moveRow(doc, id, d, null);
    expect(snap(doc, id).rows.map((r) => r.id)).toEqual([a, b, c, d]);
    moveRow(doc, id, b, "missing");
    expect(snap(doc, id).rows.map((r) => r.id)).toEqual([a, c, d, b]);
  });

  it("concurrent moves of the same row converge without duplicates", () => {
    const a0 = new Y.Doc();
    const id = createDatabase(a0, "kanban");
    const b0 = new Y.Doc();
    Y.applyUpdate(b0, Y.encodeStateAsUpdate(a0));
    const [a, , c, d] = snap(a0, id).rows.map((r) => r.id);
    moveRow(a0, id, d, a);
    moveRow(b0, id, d, c);
    Y.applyUpdate(a0, Y.encodeStateAsUpdate(b0));
    Y.applyUpdate(b0, Y.encodeStateAsUpdate(a0));
    const ra = snap(a0, id).rows.map((r) => r.id);
    expect(ra).toEqual(snap(b0, id).rows.map((r) => r.id));
    expect(ra).toHaveLength(4);
    expect(new Set(ra).size).toBe(4);
  });
});

/* --------------------------------------------------------------- UI */

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
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

/**
 * Fake layout: columns are 280px wide side by side, cards 60px tall from y=40.
 * elementFromPoint returns the column under x.
 */
function fakeLayout(el: HTMLElement) {
  const cols = () => [...el.querySelectorAll<HTMLElement>("[data-kcol]")];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.getAttribute("data-kcard");
    if (id) {
      const col = this.closest<HTMLElement>("[data-kcol]")!;
      const ci = cols().indexOf(col);
      const i = [...col.querySelectorAll("[data-kcard]")].indexOf(this);
      return { left: ci * 280, right: ci * 280 + 264, top: 40 + i * 60, bottom: 90 + i * 60, width: 264, height: 50, x: ci * 280, y: 40 + i * 60, toJSON() {} } as DOMRect;
    }
    return { left: 0, right: 1200, top: 0, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  (document as { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint = (x: number) => cols()[Math.floor(x / 280)] ?? null;
}
const card = (el: HTMLElement, title: string) => [...el.querySelectorAll<HTMLButtonElement>("[data-kcard]")].find((b) => b.textContent?.includes(title))!;
function ptr(target: EventTarget, type: string, x: number, y: number, pointerType = "mouse") {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, "pointerId", { value: 7 });
  Object.defineProperty(e, "pointerType", { value: pointerType });
  act(() => void target.dispatchEvent(e));
}

describe("Kanban drag", () => {
  let doc: Y.Doc;
  let id: string;
  beforeEach(() => {
    doc = new Y.Doc();
    id = createDatabase(doc, "kanban");
  });

  it("drags a card to another column, before a card", () => {
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    fakeLayout(el);
    // Kickoff is the 2nd card in "To do" (column 0); Draft the plan is the only card in "Doing" (column 1).
    ptr(card(el, "Kickoff"), "pointerdown", 100, 110);
    ptr(window, "pointermove", 120, 112);
    expect(document.querySelector(".ocdb-kghost")).toBeTruthy();
    ptr(window, "pointermove", 380, 50);
    expect(el.querySelector('[data-kcol="Doing"] .ocdb-kdrop')).toBeTruthy();
    expect(el.querySelector('[data-kcol="Doing"]')!.classList.contains("over")).toBe(true);
    ptr(window, "pointerup", 380, 50);
    expect(statusOf(doc, id, "Kickoff")).toBe("Doing");
    const t = titles(doc, id);
    expect(t.indexOf("Kickoff")).toBeLessThan(t.indexOf("Draft the plan"));
    expect(document.querySelector(".ocdb-kghost")).toBeNull();
    // the click that follows a drag must not open the peek
    act(() => card(el, "Kickoff").click());
    expect(document.querySelector(".ocdb-side")).toBeNull();
  });

  it("reorders within a column and persists via order", () => {
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    fakeLayout(el);
    ptr(card(el, "Kickoff"), "pointerdown", 100, 110);
    ptr(window, "pointermove", 100, 60);
    ptr(window, "pointermove", 100, 50);
    ptr(window, "pointerup", 100, 50);
    expect(statusOf(doc, id, "Kickoff")).toBe("To do");
    const t = titles(doc, id);
    expect(t.indexOf("Kickoff")).toBeLessThan(t.indexOf("Review with stakeholders"));
    const cards = [...el.querySelectorAll('[data-kcol="To do"] [data-kcard]')].map((c) => c.querySelector(".ocdb-kt")!.textContent);
    expect(cards).toEqual(["Kickoff", "Review with stakeholders"]);
  });

  it("touch: long-press 250 ms picks up; moving first is a scroll", () => {
    vi.useFakeTimers();
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env("edit", true)} />);
    fakeLayout(el);
    // scroll gesture: moves > 8px before the long-press fires
    ptr(card(el, "Kickoff"), "pointerdown", 100, 110, "touch");
    ptr(window, "pointermove", 100, 140, "touch");
    act(() => void vi.advanceTimersByTime(300));
    expect(document.querySelector(".ocdb-kghost")).toBeNull();
    ptr(window, "pointerup", 100, 140, "touch");
    // long-press
    ptr(card(el, "Kickoff"), "pointerdown", 100, 110, "touch");
    act(() => void vi.advanceTimersByTime(200));
    expect(document.querySelector(".ocdb-kghost")).toBeNull();
    act(() => void vi.advanceTimersByTime(60));
    expect(document.querySelector(".ocdb-kghost")).toBeTruthy();
    // page scrolling is blocked while a card is held
    const tm = new Event("touchmove", { cancelable: true });
    document.dispatchEvent(tm);
    expect(tm.defaultPrevented).toBe(true);
    ptr(window, "pointermove", 660, 60, "touch");
    ptr(window, "pointerup", 660, 60, "touch");
    expect(statusOf(doc, id, "Kickoff")).toBe("Review");
  });

  it("viewers cannot drag", () => {
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env("view")} />);
    fakeLayout(el);
    ptr(card(el, "Kickoff"), "pointerdown", 100, 110);
    ptr(window, "pointermove", 380, 50);
    ptr(window, "pointerup", 380, 50);
    expect(statusOf(doc, id, "Kickoff")).toBe("To do");
    expect(document.querySelector(".ocdb-kghost")).toBeNull();
  });
});

describe("Kanban keyboard", () => {
  const key = (t: Element, k: string) => act(() => void t.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));

  it("Space picks up, arrows move, Space drops", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "kanban");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const c = card(el, "Kickoff");
    act(() => c.focus());
    key(c, " ");
    expect(card(el, "Kickoff").getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector(".ocdb-sr")!.textContent).toMatch(/Picked up Kickoff/);
    key(card(el, "Kickoff"), "ArrowRight");
    expect(statusOf(doc, id, "Kickoff")).toBe("Doing");
    expect(document.activeElement).toBe(card(el, "Kickoff"));
    key(card(el, "Kickoff"), "ArrowUp");
    let t = titles(doc, id);
    expect(t.indexOf("Kickoff")).toBeLessThan(t.indexOf("Draft the plan"));
    key(card(el, "Kickoff"), "ArrowDown");
    t = titles(doc, id);
    expect(t.indexOf("Kickoff")).toBeGreaterThan(t.indexOf("Draft the plan"));
    key(card(el, "Kickoff"), " ");
    expect(card(el, "Kickoff").getAttribute("aria-pressed")).toBe("false");
    expect(el.querySelector(".ocdb-sr")!.textContent).toMatch(/Dropped Kickoff in Doing/);
    // Arrow keys do nothing once dropped
    key(card(el, "Kickoff"), "ArrowRight");
    expect(statusOf(doc, id, "Kickoff")).toBe("Doing");
  });

  it("Escape puts the card back", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "kanban");
    const before = titles(doc, id);
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    act(() => card(el, "Kickoff").focus());
    key(card(el, "Kickoff"), " ");
    key(card(el, "Kickoff"), "ArrowRight");
    key(card(el, "Kickoff"), "ArrowRight");
    key(card(el, "Kickoff"), "ArrowUp");
    expect(statusOf(doc, id, "Kickoff")).toBe("Review");
    key(card(el, "Kickoff"), "Escape");
    expect(statusOf(doc, id, "Kickoff")).toBe("To do");
    expect(titles(doc, id)).toEqual(before);
  });
});

describe("Shared calendar month", () => {
  function pair() {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array, o: unknown) => o !== "remote" && Y.applyUpdate(b, u, "remote"));
    b.on("update", (u: Uint8Array, o: unknown) => o !== "remote" && Y.applyUpdate(a, u, "remote"));
    return [a, b] as const;
  }

  it("navigating writes views.calendar.cal and collaborators follow", () => {
    const [a, b] = pair();
    const id = createDatabase(a, "content");
    setView(a, id, "calendar");
    const el = mount(<DatabaseBlock doc={a} dbId={id} env={env()} />);
    const label = () => el.querySelector(".ocdb-calh b")!.textContent;
    const start = label();
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    const cal = snap(b, id).views.calendar?.cal;
    expect(cal).toMatch(/^\d{4}-\d{2}$/);
    expect(label()).not.toBe(start);
    // a remote change of month is reflected
    const [y, m] = cal!.split("-").map(Number);
    const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
    act(() => {
      const vm = getDbMap(b, id)!.get("views") as Y.Map<unknown>;
      vm.set("calendar", { ...(vm.get("calendar") as object), cal: prev });
    });
    expect(label()).toBe(start);
  });

  it("viewers navigate locally without writing", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "content");
    setView(doc, id, "calendar");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env("view")} />);
    const sv = Y.encodeStateVector(doc);
    const start = el.querySelector(".ocdb-calh b")!.textContent;
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    expect(el.querySelector(".ocdb-calh b")!.textContent).not.toBe(start);
    expect(Y.encodeStateVector(doc)).toEqual(sv);
  });
});
