// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// Large tables and boards (DB4-07/08/09, prototype large-tables 1a-1d, 3a-3c).

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockEnv } from "@opencanvas/ui";
import { DatabaseBlock } from "../index";
import { addField, createDatabase, DB_ORIGIN, getDbMap, readDb, setPrefs, setView } from "../model";
import { bulkDelete, bulkSet } from "./bulk";
import { sortOrder } from "./sortcore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: string[] = [];
const env = (compact = false): BlockEnv => ({ role: "edit", compact, me: { id: "p", name: "P", color: "#000" }, users: [], toast: (m) => void toasts.push(m) });

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
  cleanup = () => act(() => root.unmount());
  return el;
}

/** A database with `n` rows: title "Task i", Est = i % 7, Status cycling. */
function big(n: number) {
  const doc = new Y.Doc();
  const id = createDatabase(doc, "blank");
  const m = getDbMap(doc, id)!;
  const fields = readDb(id, m).fields;
  const t = fields.find((f) => f.type === "title")!.id;
  const est = addField(doc, id, "number", "Est");
  const st = addField(doc, id, "status", "Status");
  doc.transact(() => {
    const rows = m.get("rows") as Y.Map<Y.Map<unknown>>;
    const order = m.get("order") as Y.Array<string>;
    rows.clear();
    order.delete(0, order.length);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = new Y.Map<unknown>();
      r.set(t, `Task ${i + 1}`);
      r.set(est, i % 7);
      r.set(st, ["Not started", "In progress", "Done"][i % 3]);
      rows.set("r" + i, r);
      ids.push("r" + i);
    }
    order.push(ids);
  });
  return { doc, id, t, est, st };
}

describe("sort core", () => {
  it("is stable, keeps empty cells last in either direction, and reports progress", () => {
    const keys = [new Float64Array([3, NaN, 1, 3, 2])];
    const seen: number[] = [];
    expect([...sortOrder({ keys, dirs: [1], n: 5 }, (p) => seen.push(p))]).toEqual([2, 4, 0, 3, 1]);
    expect([...sortOrder({ keys, dirs: [-1], n: 5 })]).toEqual([0, 3, 4, 2, 1]);
    expect(seen.at(-1)).toBe(1);
    expect([...sortOrder({ keys: [["b", "", "a"]], dirs: [1], n: 3 })]).toEqual([2, 0, 1]);
  });
});

describe("bulk edit", () => {
  it("sets one field in batches of 2,000, undone as one step", async () => {
    const { doc, id, st } = big(5000);
    const um = new Y.UndoManager(getDbMap(doc, id)!, { trackedOrigins: new Set([DB_ORIGIN]), captureTimeout: 0 });
    let txs = 0;
    doc.on("afterTransaction", (tr: Y.Transaction) => void (tr.origin === DB_ORIGIN && txs++));
    const ids = readDb(id, getDbMap(doc, id)!).rows.map((r) => r.id);
    const progress: number[] = [];
    const r = await bulkSet(doc, id, ids, st, "Done", um, (p) => progress.push(p.done));
    expect(r).toMatchObject({ done: 5000, total: 5000, cancelled: false });
    expect(txs).toBe(3);
    expect(progress).toEqual([2000, 4000, 5000]);
    expect(readDb(id, getDbMap(doc, id)!).rows.every((x) => x.v[st] === "Done")).toBe(true);
    expect(um.undoStack.length).toBe(1);
    um.undo();
    expect(readDb(id, getDbMap(doc, id)!).rows.filter((x) => x.v[st] === "Done").length).toBe(1666);
  });

  it("stops after the current batch when cancelled, and deletes keep order", async () => {
    const { doc, id, st } = big(5000);
    const ids = readDb(id, getDbMap(doc, id)!).rows.map((r) => r.id);
    let n = 0;
    const r = await bulkSet(doc, id, ids, st, "Done", null, () => n++, () => n >= 1);
    expect(r).toMatchObject({ done: 2000, cancelled: true });
    await bulkDelete(doc, id, ids.filter((_, i) => i % 2 === 0), null);
    const left = readDb(id, getDbMap(doc, id)!).rows.map((x) => x.id);
    expect(left.length).toBe(2500);
    expect(left.slice(0, 3)).toEqual(["r1", "r3", "r5"]);
  });
});

describe("large table", () => {
  it("renders only the rows and columns near the viewport, with a sticky header and frozen column", async () => {
    const { doc, id } = big(20_000);
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const grid = el.querySelector("[role=grid]")!;
    expect(grid.getAttribute("aria-rowcount")).toBe("20001");
    const rendered = el.querySelectorAll(".ocdb-lt-r").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    expect(el.querySelector(".ocdb-lt-hd .ocdb-lt-fz")).toBeTruthy();
    expect(el.querySelector(".ocdb-hcb")?.textContent).toBe("20,000 rows");
  });

  it("phone: a long press selects the card, and the click that ends it does not undo that", async () => {
    const { doc, id } = big(2000);
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env(true)} />);
    const cards = () => [...el.querySelectorAll<HTMLButtonElement>(".ocdb-lt-card")];
    const bar = () => el.querySelector(".ocdb-lt-selbar");
    vi.useFakeTimers();
    try {
      const c = cards()[1];
      await act(async () => {
        c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        vi.advanceTimersByTime(600);
      });
      await act(async () => {
        c.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        c.click();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(bar()?.querySelector(".ocdb-lt-cnt")?.textContent).toBe("1 selected");
    // Then taps toggle further cards.
    await act(async () => cards()[2].click());
    expect(bar()?.querySelector(".ocdb-lt-cnt")?.textContent).toBe("2 selected");
  });

  it("row numbers are row headers holding a toggle (no aria-pressed on the rowheader)", async () => {
    const { doc, id } = big(2000);
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const heads = el.querySelectorAll(".ocdb-lt-r [role=rowheader]");
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) {
      expect(h.hasAttribute("aria-pressed")).toBe(false);
      expect(h.querySelector("button[aria-pressed]")).toBeTruthy();
    }
    const first = el.querySelector<HTMLButtonElement>(".ocdb-lt-r [role=rowheader] button")!;
    await act(async () => first.click());
    expect(first.getAttribute("aria-pressed")).toBe("true");
  });

  it("Ctrl+G and the count open Go to row; going flashes and focuses the row", async () => {
    const { doc, id } = big(5000);
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const grid = el.querySelector<HTMLElement>("[role=grid]")!;
    await act(async () => grid.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true })));
    const dlg = el.querySelector("[role=dialog][aria-label='Go to row']")!;
    expect(dlg.textContent).toContain("1 to 5,000");
    const bottom = [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Bottom")!;
    await act(async () => bottom.click());
    expect(el.querySelector("[role=dialog][aria-label='Go to row']")).toBeNull();
    expect(el.querySelector(".ocdb-lt-r.flash")?.getAttribute("data-row")).toBe("r4999");
  });

  it("selecting the screen offers an explicit Select all N, then bulk edit names the count", async () => {
    const { doc, id } = big(5000);
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    await act(async () => el.querySelector<HTMLButtonElement>(".ocdb-lt-hd .ocdb-lt-ck")!.click());
    const bar = () => el.querySelector(".ocdb-lt-selbar")!;
    const screen = Number(bar().querySelector(".ocdb-lt-cnt")!.textContent!.split(" ")[0].replace(",", ""));
    expect(screen).toBeGreaterThan(0);
    expect(screen).toBeLessThan(5000);
    const all = [...bar().querySelectorAll("button")].find((b) => b.textContent === "Select all 5,000")!;
    await act(async () => all.click());
    expect(bar().querySelector(".ocdb-lt-cnt")!.textContent).toBe("5,000 selected");
    await act(async () => [...bar().querySelectorAll("button")].find((b) => b.textContent?.includes("Edit field"))!.click());
    const dlg = el.querySelector("[role=dialog][aria-label='Edit 5,000 rows']")!;
    expect(dlg.textContent).toContain("Undo with Ctrl Z reverts all 5,000 at once.");
  });

  it("the board virtualizes each lane and shows full lane counts", async () => {
    const { doc, id, st } = big(6000);
    setView(doc, id, "board");
    setPrefs(doc, id, "board", { group: st });
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    const lanes = [...el.querySelectorAll(".ocdb-lb-lane")];
    expect(lanes.map((l) => l.querySelector(".ocdb-lb-n")!.textContent)).toEqual(["2,000", "2,000", "2,000"]);
    expect(el.querySelectorAll(".ocdb-lb-card").length).toBeLessThan(400);
  });

  it("sorts large tables off the render path (in-thread fallback without workers)", async () => {
    const { doc, id, est } = big(3000);
    setPrefs(doc, id, "table", { sorts: [{ f: est, dir: -1 }], sort: { f: est, dir: -1 } });
    const el = await mount(<DatabaseBlock doc={doc} dbId={id} env={env()} />);
    await act(async () => {});
    const first = el.querySelector(".ocdb-lt-r .ocdb-lt-c.num")?.textContent;
    expect(first).toBe("6");
  });
});
