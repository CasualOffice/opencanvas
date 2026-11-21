// @vitest-environment jsdom
// UX pass (docs/20-BLOCKS-UX-AUDIT.md): field editing, multi-sort/filter, spreadsheet keyboard,
// clipboard, row/column reordering, virtualisation, undo, peek navigation, CSV import undo.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "./index";
import { addRow, createDatabase, importCsvToDatabase, getDbMap, moveField, pasteCells, readDb, setCell, setFieldType, setOptions, setPrefs, setView } from "./model";
import { filtersOf, groupField, highlightParts, sortsOf, visibleRows } from "./query";
import { isGridText, moveCell, parseTsv, rangeToTsv } from "./grid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const users = [{ id: "asha", name: "Asha Rao", color: "#7a45f0" }, { id: "ravi", name: "Ravi Menon", color: "#e5602a" }];
const toasts: { m: string; run?: () => void }[] = [];
const env = (): BlockEnv => ({ role: "edit", compact: false, me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" }, users, toast: (m, a) => void toasts.push({ m, run: a?.run }) });
const snap = (doc: Y.Doc, id: string) => readDb(id, getDbMap(doc, id)!);

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  toasts.length = 0;
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

describe("field editing", () => {
  it("changes a text field to select, building options from the values", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const db = snap(doc, id);
    const rows = db.rows.map((r) => r.id);
    // Points (number) -> select: values become options, cells keep their text.
    const pts = db.fields.find((f) => f.type === "number")!;
    setFieldType(doc, id, pts.id, "select");
    const after = snap(doc, id);
    const f = after.fields.find((x) => x.id === pts.id)!;
    expect(f.type).toBe("select");
    expect(f.options!.map((o) => o.v).sort()).toEqual(["2", "3", "5", "8"]);
    expect(after.rows.find((r) => r.id === rows[0])!.v[pts.id]).toBe(String(db.rows[0].v[pts.id]));
    // ...and back to number.
    setFieldType(doc, id, pts.id, "number");
    expect(snap(doc, id).rows[0].v[pts.id]).toBe(db.rows[0].v[pts.id]);
  });

  it("never changes the title field's type", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    setFieldType(doc, id, "title", "number");
    expect(snap(doc, id).fields[0].type).toBe("title");
  });

  it("renames an option and every cell follows; deleting one clears it", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const st = snap(doc, id).fields.find((f) => f.type === "status")!;
    const before = snap(doc, id).rows.filter((r) => r.v[st.id] === "In progress").length;
    expect(before).toBeGreaterThan(0);
    setOptions(doc, id, st.id, st.options!.map((o) => (o.v === "In progress" ? { v: "Doing", c: "purple" } : o)), { "In progress": "Doing" });
    const db = snap(doc, id);
    expect(db.rows.filter((r) => r.v[st.id] === "Doing")).toHaveLength(before);
    expect(db.fields.find((f) => f.id === st.id)!.options!.find((o) => o.v === "Doing")!.c).toBe("purple");
    setOptions(doc, id, st.id, db.fields.find((f) => f.id === st.id)!.options!.filter((o) => o.v !== "Doing"));
    expect(snap(doc, id).rows.filter((r) => r.v[st.id] === "Doing")).toHaveLength(0);
  });

  it("moves a field and keeps its values", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const ids = snap(doc, id).fields.map((f) => f.id);
    moveField(doc, id, ids[1], 3);
    const after = snap(doc, id);
    expect(after.fields.map((f) => f.id)).toEqual([ids[0], ids[2], ids[3], ids[1], ...ids.slice(4)]);
    expect(after.rows[0].v[ids[1]]).toBe(snap(doc, id).rows[0].v[ids[1]]);
  });
});

describe("clipboard", () => {
  it("parses spreadsheet TSV with quotes and copies a range back", () => {
    expect(parseTsv('a\tb\n"line\nbreak"\t"q ""x"""\n')).toEqual([["a", "b"], ["line\nbreak", 'q "x"']]);
    expect(isGridText("one value")).toBe(false);
    expect(isGridText("one value\n")).toBe(false);
    expect(isGridText("a\tb")).toBe(true);
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const db = snap(doc, id);
    const tsv = rangeToTsv({ a: { r: 0, c: 1 }, f: { r: 1, c: 2 } }, db.rows, db.fields, users);
    expect(tsv.split("\n")).toHaveLength(2);
    expect(tsv.split("\n")[0].split("\t")).toHaveLength(2);
  });

  it("pastes a block, converting types, adding options and rows", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const db = snap(doc, id);
    const last = db.rows.slice(-1).map((r) => r.id);
    const written = pasteCells(doc, id, last, ["title", "status", "pts"], [["A", "Blocked", "7"], ["B", "Done", "x"]], users);
    expect(written).toHaveLength(2);
    const after = snap(doc, id);
    expect(after.rows).toHaveLength(db.rows.length + 1);
    const a = after.rows.find((r) => r.id === last[0])!;
    expect([a.v.title, a.v.status, a.v.pts]).toEqual(["A", "Blocked", 7]);
    expect(after.fields.find((f) => f.id === "status")!.options!.some((o) => o.v === "Blocked")).toBe(true);
    expect(after.rows.at(-1)!.v.pts).toBeNull();
  });
});

describe("query", () => {
  it("sorts by several keys and filters with AND; legacy single sort still works", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const db = snap(doc, id);
    const two = visibleRows(db, { sorts: [{ f: "owner", dir: 1 }, { f: "pts", dir: -1 }] }, users);
    for (let i = 1; i < two.length; i++) {
      const [p, q] = [two[i - 1], two[i]];
      if (p.v.owner === q.v.owner) expect(Number(p.v.pts)).toBeGreaterThanOrEqual(Number(q.v.pts));
    }
    const legacy = visibleRows(db, { sort: { f: "pts", dir: 1 } }, users);
    expect(legacy.map((r) => r.v.pts)).toEqual([...legacy.map((r) => r.v.pts)].sort((a, b) => Number(a) - Number(b)));
    const owner = String(db.rows[0].v.owner), status = String(db.rows[0].v.status);
    const both = visibleRows(db, { filters: [{ f: "owner", vals: [owner] }, { f: "status", vals: [status] }] }, users);
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((r) => r.v.owner === owner && r.v.status === status)).toBe(true);
    expect(sortsOf(db, { sort: { f: "nope", dir: 1 } })).toEqual([]);
    expect(filtersOf(db, { filter: { f: "status", vals: [] } })).toEqual([]);
  });

  it("group-by and date field follow the view's choice", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const db = snap(doc, id);
    expect(groupField(db)!.type).toBe("status");
    expect(groupField(db, { group: "nope" })!.type).toBe("status");
    const sel = db.fields.find((f) => f.type === "select" || f.type === "status")!;
    expect(groupField(db, { group: sel.id })!.id).toBe(sel.id);
  });

  it("splits text for search highlights", () => {
    expect(highlightParts("Room WAL room", "room")).toEqual([{ t: "Room", hit: true }, { t: " WAL ", hit: false }, { t: "room", hit: true }]);
    expect(moveCell({ r: 0, c: 0 }, "ArrowUp", 5, 3)).toEqual({ r: 0, c: 0 });
    expect(moveCell({ r: 2, c: 1 }, "End", 5, 3, true)).toEqual({ r: 4, c: 2 });
  });
});

describe("table interaction", () => {
  const titles = (el: Element) => [...el.querySelectorAll<HTMLInputElement>("tbody td[data-c='0'] input")].map((i) => i.value);

  it("moves between cells with the arrow keys like a spreadsheet", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const first = el.querySelector<HTMLInputElement>("td[data-r='0'][data-c='0'] input")!;
    act(() => first.focus());
    key(first, "ArrowDown");
    expect(document.activeElement).toBe(el.querySelector("td[data-r='1'][data-c='0'] input"));
    // Caret at the end of the text: ArrowRight leaves the input for the next cell.
    const cur = document.activeElement as HTMLInputElement;
    cur.setSelectionRange(cur.value.length, cur.value.length);
    key(cur, "ArrowRight");
    expect(document.activeElement).toBe(el.querySelector("td[data-r='1'][data-c='1'] button"));
    key(document.activeElement!, "ArrowDown", { shiftKey: true });
    key(document.activeElement!, "ArrowRight", { shiftKey: true });
    expect(el.querySelectorAll("td.sel")).toHaveLength(4);
    key(document.activeElement!, "Escape");
    expect(el.querySelectorAll("td.sel")).toHaveLength(0);
  });

  it("copies a selected range as TSV and pastes a block", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const cell = el.querySelector<HTMLButtonElement>("td[data-r='0'][data-c='1'] button")!;
    act(() => cell.focus());
    key(cell, "ArrowDown", { shiftKey: true });
    const data = new Map<string, string>();
    const clip = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? "" };
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: clip });
    act(() => void cell.dispatchEvent(copy));
    expect(copy.defaultPrevented).toBe(true);
    const db = snap(doc, id);
    expect(data.get("text/plain")).toBe(`${db.rows[0].v.status}\n${db.rows[1].v.status}`);
    // Paste a 1x2 block into the title column of row 3.
    const t3 = el.querySelector<HTMLInputElement>("td[data-r='3'][data-c='0'] input")!;
    act(() => t3.focus());
    data.set("text/plain", "First\tDone\n");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: clip });
    act(() => void t3.dispatchEvent(paste));
    const r3 = snap(doc, id).rows[3];
    expect([r3.v.title, r3.v.status]).toEqual(["First", "Done"]);
    // Delete clears the range (single cell here) on a non-text cell.
    const st = el.querySelector<HTMLButtonElement>("td[data-r='3'][data-c='1'] button")!;
    act(() => st.focus());
    key(st, "Delete");
    expect(snap(doc, id).rows[3].v.status).toBeNull();
  });

  it("reorders rows with Alt+Shift+arrows and refuses while sorted", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const before = titles(el);
    const first = el.querySelector<HTMLInputElement>("td[data-r='0'][data-c='0'] input")!;
    act(() => first.focus());
    key(first, "ArrowDown", { altKey: true, shiftKey: true });
    expect(titles(el).slice(0, 2)).toEqual([before[1], before[0]]);
    // The grip button moves rows with plain arrow keys.
    const grip = el.querySelector<HTMLButtonElement>("tr[data-row] .ocdb-grip")!;
    key(grip, "ArrowDown");
    expect(titles(el).slice(0, 2)).toEqual([before[0], before[1]]);
    act(() => setPrefs(doc, id, "table", { sorts: [{ f: "pts", dir: 1 }] }));
    expect(el.querySelector(".ocdb-grip")).toBeNull();
    const t = el.querySelector<HTMLInputElement>("td[data-r='0'][data-c='0'] input")!;
    const sorted = titles(el);
    key(t, "ArrowDown", { altKey: true, shiftKey: true });
    expect(titles(el)).toEqual(sorted);
    expect(toasts.at(-1)!.m).toMatch(/Clear the sort/);
  });

  it("moves and resizes columns from the keyboard", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const ids = snap(doc, id).fields.map((f) => f.id);
    const head = el.querySelectorAll<HTMLButtonElement>("th .ocdb-hcell")[1];
    key(head, "ArrowRight", { altKey: true, shiftKey: true });
    // Column order is per view (D22); the shared field list stays as it was (D24).
    expect(snap(doc, id).views.table.fields!.slice(0, 3)).toEqual([ids[0], ids[2], ids[1]]);
    expect(snap(doc, id).fields.map((f) => f.id)).toEqual(ids);
    const sep = el.querySelector<HTMLElement>(`th[data-fid="${ids[2]}"] .ocdb-rsz`)!;
    const w0 = Number(sep.getAttribute("aria-valuenow"));
    key(sep, "ArrowRight");
    expect(snap(doc, id).views.table.widths![ids[2]]).toBe(w0 + 16);
    key(sep, "Home");
    expect(snap(doc, id).views.table.widths![ids[2]]).toBeUndefined();
  });

  it("renders only the rows near the viewport for large tables", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "blank");
    doc.transact(() => {
      for (let i = 0; i < 1000; i++) addRow(doc, id, { title: "Row " + i });
    });
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const rendered = el.querySelectorAll("tbody tr[data-row]").length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(120);
    expect(el.querySelector("table")!.getAttribute("aria-rowcount")).toBe("1004");
    expect(el.querySelector("tfoot")!.textContent).toContain("1003");
  });

  it("undoes this user's own edits with Ctrl+Z, outside text fields", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const rid = snap(doc, id).rows[0].id;
    const was = snap(doc, id).rows[0].v.status;
    act(() => setCell(doc, id, rid, "status", "Done"));
    // A remote change is not undone.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    setCell(remote, id, rid, "title", "Remote title");
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote)));
    const btn = el.querySelector<HTMLButtonElement>("td[data-r='0'][data-c='1'] button")!;
    key(btn, "z", { ctrlKey: true });
    expect(snap(doc, id).rows[0].v.status).toBe(was);
    expect(snap(doc, id).rows[0].v.title).toBe("Remote title");
    key(btn, "z", { ctrlKey: true, shiftKey: true });
    expect(snap(doc, id).rows[0].v.status).toBe("Done");
  });
});

describe("peek and import", () => {
  it("steps to the next and previous row and gives focus back on close", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const open = el.querySelectorAll<HTMLButtonElement>(".ocdb-peekbtn")[1];
    act(() => open.focus());
    act(() => open.click());
    expect(document.querySelector(".ocdb-pcount")!.textContent).toBe("2 of 7");
    act(() => document.querySelector<HTMLButtonElement>('[data-nav="next"]')!.click());
    expect(document.querySelector(".ocdb-pcount")!.textContent).toBe("3 of 7");
    const panel = document.querySelector<HTMLElement>(".ocdb-side")!;
    key(panel, "k");
    expect(document.querySelector(".ocdb-pcount")!.textContent).toBe("2 of 7");
    key(panel, "ArrowDown", { altKey: true });
    expect(document.querySelector(".ocdb-pcount")!.textContent).toBe("3 of 7");
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".ocdb-side")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("CSV import can be undone from its toast", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const n0 = snap(doc, id).rows.length;
    const f0 = snap(doc, id).fields.length;
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Database options"]')!.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>(".ocdb-pop .ocdb-mi")].find((b) => b.textContent === "Import CSV")!.click());
    const ta = document.querySelector<HTMLTextAreaElement>(".ocdb-modal textarea")!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(ta, "Task,Brand new column\nOne,x\nTwo,y\n");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => [...document.querySelectorAll<HTMLButtonElement>(".ocdb-modal button")].find((b) => b.textContent?.startsWith("Import"))!.click());
    expect(snap(doc, id).rows.length).toBe(n0 + 2);
    expect(snap(doc, id).fields.length).toBe(f0 + 1);
    const t = toasts.find((x) => x.m.startsWith("Imported 2"))!;
    act(() => t.run!());
    expect(snap(doc, id).rows.length).toBe(n0);
    expect(snap(doc, id).fields.length).toBe(f0);
  });

  it("board view groups by the chosen field and offers to add one when missing", () => {
    const doc = new Y.Doc();
    const id = importCsvToDatabase(doc, "Name,Notes\nOne,long free text one\nTwo,long free text two\n");
    setView(doc, id, "board");
    const el = mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const add = [...el.querySelectorAll<HTMLButtonElement>(".ocdb-empty button")].find((b) => b.textContent?.includes("Status"));
    expect(add).toBeTruthy();
    act(() => add!.click());
    expect(el.querySelector(".ocdb-kan")).toBeTruthy();
  });
});
