// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Replaces the `#demo` canvas's first database with `rows` rows × `fields` fields in one local
// transaction (Task, Status with six options, then numbers, dates and text), and exposes
// `window.__countDone()` (rows whose Status is Done).
import type { Page } from "@playwright/test";

export async function fillDemoDb(page: Page, rows: number, fields: number) {
  await page.evaluate(({ rows, fields }) => {
    type YM = { get(k: string): unknown; set(k: string, v: unknown): void; keys(): IterableIterator<string>; forEach(f: (v: YM) => void): void };
    const ed = (window as unknown as { __ocEditor: { extensionManager: { extensions: { name: string; options: { document: unknown } }[] } } }).__ocEditor;
    const doc = ed.extensionManager.extensions.find((e) => e.name === "collaboration")!.options.document as { getMap(n: string): YM; transact(f: () => void): void };
    const dbs = doc.getMap("databases");
    const db = dbs.get([...dbs.keys()][0]) as YM;
    const YMap = (dbs as unknown as { constructor: new () => YM }).constructor;
    const YArray = (db.get("order") as { constructor: new () => { push(v: unknown[]): void } }).constructor;
    const lanes = ["Not started", "In progress", "In review", "Blocked", "Done", "Won't do"];
    doc.transact(() => {
      const fs = new YArray();
      const defs = [{ id: "t", type: "title", name: "Task" }, { id: "s", type: "status", name: "Status" }];
      for (let i = 2; i < fields; i++) defs.push({ id: "f" + i, type: ["number", "date", "text"][i % 3], name: `Field ${i}` });
      fs.push(defs.map((d) => {
        const m = new YMap();
        m.set("id", d.id);
        m.set("name", d.name);
        m.set("type", d.type);
        m.set("options", d.type === "status" ? lanes.map((v, k) => ({ v, c: ["gray", "blue", "purple", "red", "green", "amber"][k] })) : null);
        return m;
      }));
      db.set("fields", fs);
      const rm = new YMap();
      const order = new YArray();
      const ids: string[] = [];
      for (let r = 0; r < rows; r++) {
        const row = new YMap();
        for (const d of defs) row.set(d.id, d.type === "title" ? `Task ${r + 1}` : d.type === "status" ? lanes[r % 4] : d.type === "number" ? r % 40 : d.type === "date" ? `2026-12-${String(1 + (r % 28)).padStart(2, "0")}` : `S${r % 9}`);
        rm.set("r" + r, row);
        ids.push("r" + r);
      }
      db.set("rows", rm);
      order.push(ids);
      db.set("order", order);
      db.set("view", "table");
    });
    (window as unknown as { __countDone(): number }).__countDone = () => {
      let n = 0;
      (db.get("rows") as YM).forEach((r) => void (r.get("s") === "Done" && n++));
      return n;
    };
  }, { rows, fields });
}
