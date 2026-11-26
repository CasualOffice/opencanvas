// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Formula, relation and rollup fields in the database block (DB4-03..06, prototype frames 1-4).

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "../index";
import { addField, addRow, createDatabase, databasesRoot, getDbMap, readDb, renameField } from "../model";
import { setEngineSource, loadEngine } from "./engine";
import { addRelation, makeAdvanced, setRelation, sweepGone, unpairBack } from "./model";
import { caretInfo, FormulaEditor } from "./FormulaEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Fs { readFileSync(p: string): Uint8Array<ArrayBuffer> }
const { readFileSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as Fs;
const wasm = readFileSync("src/formula/oc_formula.wasm");

beforeAll(() => setEngineSource(async () => wasm.slice().buffer));

const env = (formulas = true): BlockEnv => ({
  role: "edit",
  compact: false,
  formulas,
  me: { id: "priya", name: "Priya Shah", color: "#2a5ad7" },
  users: [],
  toast: () => {},
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  // The engine loads asynchronously, then values compute.
  await act(async () => void (await loadEngine()));
  await act(async () => {});
  cleanup = () => act(() => root.unmount());
  return el;
}

const db = (doc: Y.Doc, id: string) => readDb(id, getDbMap(doc, id)!);
const title = (doc: Y.Doc, id: string) => db(doc, id).fields.find((f) => f.type === "title")!.id;

/** A budget: Item, Price, Qty, Total = Price * Qty, Unit = Price / Qty. */
function budget() {
  const doc = new Y.Doc();
  const id = createDatabase(doc, "blank");
  const t = title(doc, id);
  for (const f of db(doc, id).fields) if (f.id !== t) databasesRoot(doc); // keep the blank preset's fields
  const price = addField(doc, id, "number", "Price");
  const qty = addField(doc, id, "number", "Qty");
  const total = addField(doc, id, "text", "Total");
  makeAdvanced(doc, id, total, "formula", { formula: 'prop("Price") * prop("Qty")' });
  const unit = addField(doc, id, "text", "Unit");
  makeAdvanced(doc, id, unit, "formula", { formula: 'prop("Price") / prop("Qty")' });
  for (const r of db(doc, id).rows) getDbMap(doc, id)!.get("rows") && (getDbMap(doc, id)!.get("rows") as Y.Map<unknown>).delete(r.id);
  const order = getDbMap(doc, id)!.get("order") as Y.Array<string>;
  order.delete(0, order.length);
  addRow(doc, id, { [t]: "Venue", [price]: 4200, [qty]: 1 });
  addRow(doc, id, { [t]: "Catering", [price]: 10, [qty]: 0 });
  return { doc, id, total, unit, price };
}

describe("formula fields", () => {
  it("show computed values, error cells with a reason, and sums that skip errors", async () => {
    const { doc, id, unit } = budget();
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const text = el.textContent ?? "";
    expect(text).toContain("4,200");
    const err = el.querySelector<HTMLElement>(".ocdb-ferr");
    expect(err?.textContent).toBe("#DIV/0");
    expect(err?.getAttribute("data-tip")).toBe("Division by zero");
    expect(err?.tabIndex).toBe(0);
    const unitCol = db(doc, id).fields.findIndex((f) => f.id === unit);
    expect(unitCol).toBeGreaterThan(0);
    expect(text).toMatch(/1 error skipped/);
  });

  it("a three-field cycle shows #CYCLE on the header and recovers", async () => {
    const { doc, id } = budget();
    const ids = ["A", "B", "C"].map((n) => addField(doc, id, "text", n));
    makeAdvanced(doc, id, ids[0], "formula", { formula: 'prop("C") + 1' });
    makeAdvanced(doc, id, ids[1], "formula", { formula: 'prop("A") + 1' });
    makeAdvanced(doc, id, ids[2], "formula", { formula: 'prop("B") + 1' });
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    expect([...el.querySelectorAll(".ocdb-hcell .ocdb-ferr")].map((x) => x.textContent)).toEqual(["#CYCLE", "#CYCLE", "#CYCLE"]);
    await act(async () => makeAdvanced(doc, id, ids[2], "formula", { formula: "10" }));
    expect(el.querySelectorAll(".ocdb-hcell .ocdb-ferr").length).toBe(0);
  });

  it("renaming a field rewrites the formulas that use it", async () => {
    const { doc, id, price, total } = budget();
    await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    renameField(doc, id, price, "Cost");
    expect(db(doc, id).fields.find((f) => f.id === total)?.formula).toBe('prop("Cost") * prop("Qty")');
  });

  it("the add-field panel offers formula, relation and rollup only with the host flag", async () => {
    const { doc, id } = budget();
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env(false)} />);
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Add a field"]')!.click());
    expect(document.querySelector('[data-t="text"]')).toBeTruthy();
    expect(document.querySelector('[data-t="formula"]')).toBeNull();
  });
});

describe("formula editor", () => {
  it("a brand-new formula field loads the engine when its panel opens", async () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "blank");
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Add a field"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-t="formula"]')!.click());
    await act(async () => void (await loadEngine()));
    await act(async () => {});
    expect(document.body.textContent).not.toContain("Loading formulas");
    expect(document.querySelector(".ocdb-fx")).toBeTruthy();
  });

  it("a new field turned into a formula is named Formula (the closing name panel does not undo it)", async () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "blank");
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Add a field"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-t="formula"]')!.click());
    const last = db(doc, id).fields.at(-1)!;
    expect(last.name).toBe("Formula");
  });

  it("checks as you type, disables Save on an error, autocompletes and saves upper case", async () => {
    const { doc, id, total } = budget();
    const engine = await loadEngine();
    const saved: string[] = [];
    const d = db(doc, id);
    const el = await mount(<FormulaEditor engine={engine} db={d} f={d.fields.find((f) => f.id === total)!} related={{}} compact={false} onSave={(s) => saved.push(s)} onCancel={() => {}} />);
    const ta = el.querySelector("textarea")!;
    const type = async (s: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => {
        set.call(ta, s);
        ta.setSelectionRange(s.length, s.length);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const save = () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(el.textContent).toContain("Number");
    expect(el.textContent).toContain("4,200");
    await type('IF(TRUE, 1, "x")');
    expect(el.querySelector(".ocdb-fx-err")?.textContent).toContain("#TYPE");
    expect(el.querySelector("mark")).toBeTruthy();
    expect(save().disabled).toBe(true);
    await type("ro");
    expect([...el.querySelectorAll("[role=option] code")].map((x) => x.textContent)).toContain("ROUND");
    await type('round(prop("Price"), 1)');
    expect(el.querySelector(".ocdb-fx-sig")).toBeNull();
    expect(save().disabled).toBe(false);
    await act(async () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(saved).toEqual(['ROUND(prop("Price"), 1)']);
  });

  it("knows the call around the caret for signature help", () => {
    expect(caretInfo("IF(prop(\"A\") > 1, ", 18).call).toBe("IF");
    expect(caretInfo('prop("Pr', 8)).toMatchObject({ inProp: true, word: "Pr" });
  });
});

describe("relations and rollups", () => {
  function two() {
    const doc = new Y.Doc();
    const projects = createDatabase(doc, "blank");
    const tasks = createDatabase(doc, "blank");
    const pt = title(doc, projects), tt = title(doc, tasks);
    const clear = (id: string) => {
      const m = getDbMap(doc, id)!;
      (m.get("rows") as Y.Map<unknown>).clear();
      const o = m.get("order") as Y.Array<string>;
      o.delete(0, o.length);
    };
    clear(projects);
    clear(tasks);
    const p1 = addRow(doc, projects, { [pt]: "Launch event" });
    const p2 = addRow(doc, projects, { [pt]: "Partner portal" });
    const done = addField(doc, tasks, "checkbox", "Done");
    const k1 = addRow(doc, tasks, { [tt]: "Book venue", [done]: true });
    const k2 = addRow(doc, tasks, { [tt]: "Print panels", [done]: false });
    const rel = addField(doc, projects, "text", "Tasks");
    addRelation(doc, projects, rel, tasks, { two: true, backName: "Project" });
    return { doc, projects, tasks, p1, p2, k1, k2, rel, done };
  }

  it("two-way: setting one side updates the other in the same transaction", () => {
    const { doc, projects, tasks, p1, k1, k2, rel } = two();
    const f = db(doc, projects).fields.find((x) => x.id === rel)!;
    expect(f.rel?.two).toBe(true);
    const back = db(doc, tasks).fields.find((x) => x.id === f.rel!.back)!;
    expect(back).toMatchObject({ name: "Project", type: "relation", rel: { db: projects, two: true, back: rel } });
    let txs = 0;
    doc.on("afterTransaction", () => txs++);
    setRelation(doc, projects, p1, f, [k1, k2]);
    expect(txs).toBe(1);
    const tv = db(doc, tasks).rows;
    expect(tv.find((r) => r.id === k1)!.v[back.id]).toEqual([p1]);
    setRelation(doc, projects, p1, f, [k2]);
    expect(db(doc, tasks).rows.find((r) => r.id === k1)!.v[back.id]).toEqual([]);
    unpairBack(doc, f);
    expect(db(doc, tasks).fields.find((x) => x.id === back.id)!.rel).toEqual({ db: projects });
  });

  it("rollups: count, percent; a dash when nothing relates; chips show related titles", async () => {
    const { doc, projects, p1, k1, k2, rel, done } = two();
    const f = db(doc, projects).fields.find((x) => x.id === rel)!;
    setRelation(doc, projects, p1, f, [k1, k2]);
    const n = addField(doc, projects, "text", "Task count");
    makeAdvanced(doc, projects, n, "rollup", { roll: { rel, fn: "count" } });
    const pc = addField(doc, projects, "text", "Done");
    makeAdvanced(doc, projects, pc, "rollup", { roll: { rel, f: done, fn: "percent" } });
    const el = await mount(<DatabaseBlock doc={doc} dbId={projects} env={env()} />);
    const rows = [...el.querySelectorAll("tbody tr[data-row]")].map((tr) => tr.textContent);
    expect(rows[0]).toContain("Book venue");
    expect(rows[0]).toContain("50%");
    expect(rows[1]).toContain("—");
    expect(rows[1]).not.toContain("0%");
  });

  it("a deleted target keeps the ids for 30 days, then clears them; restoring brings the links back", () => {
    const { doc, projects, tasks, p1, k1, rel } = two();
    const f = db(doc, projects).fields.find((x) => x.id === rel)!;
    setRelation(doc, projects, p1, f, [k1]);
    const saved = getDbMap(doc, tasks)!.clone();
    databasesRoot(doc).delete(tasks);
    expect(sweepGone(doc, projects, "2026-11-26")).toBe("marked");
    expect(db(doc, projects).fields.find((x) => x.id === rel)!.rel!.goneAt).toBe("2026-11-26");
    expect(sweepGone(doc, projects, "2026-12-20")).toBe("none");
    expect(db(doc, projects).rows[0].v[rel]).toEqual([k1]);
    databasesRoot(doc).set(tasks, saved);
    expect(sweepGone(doc, projects, "2026-12-21")).toBe("restored");
    databasesRoot(doc).delete(tasks);
    sweepGone(doc, projects, "2026-12-22");
    expect(sweepGone(doc, projects, "2027-01-25")).toBe("cleared");
    expect(db(doc, projects).rows[0].v[rel]).toEqual([]);
  });

  it("across canvases: “No access” chips, without counts", async () => {
    const { doc, projects, p1 } = two();
    const x = addField(doc, projects, "text", "Vendor");
    makeAdvanced(doc, projects, x, "relation", { rel: { db: "v1", file: "procurement" } });
    (getDbMap(doc, projects)!.get("rows") as Y.Map<Y.Map<unknown>>).get(p1)!.set(x, ["a", "b", "c"]);
    const el = await mount(<DatabaseBlock doc={doc} dbId={projects} env={{ ...env(), liveDb: () => "noAccess" }} />);
    const chips = [...el.querySelectorAll(".ocdb-noacc")];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].textContent).toBe("No access");
    expect(el.querySelector("tbody")!.textContent).not.toMatch(/\+\d|3/);
  });
});
