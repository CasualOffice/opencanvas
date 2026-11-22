// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { coerce, detectFields, detectType, parseCsv } from "./csv";
import {
  addField, addRow, appendCsv, createDatabase, databaseToCsv, deleteField, deleteRow, getDbMap, importCsvToDatabase, readDb,
  restoreField, restoreRow, setCell, setPrefs,
} from "./model";
import { DB_PRESETS, PRESETS } from "./presets";
import { visibleRows } from "./query";
import { FIELD_TYPES } from "./types";

const snap = (doc: Y.Doc, id: string) => readDb(id, getDbMap(doc, id)!);

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });
  it("handles quoted cells with commas and newlines", () => {
    expect(parseCsv('name,note\n"Smith, J","line 1\nline 2"')).toEqual([["name", "note"], ["Smith, J", "line 1\nline 2"]]);
  });
  it("handles escaped quotes", () => {
    expect(parseCsv('t\n"Templates: ""Retro"" pack"\n"""quoted"""')).toEqual([["t"], ['Templates: "Retro" pack'], ['"quoted"']]);
  });
  it("handles CRLF and lone CR line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4\r\n")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(parseCsv("a,b\r1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('a\r\n"x\r\ny"')).toEqual([["a"], ["x\r\ny"]]);
  });
  it("detects tab-separated input", () => {
    expect(parseCsv("a\tb\n1, one\t2")).toEqual([["a", "b"], ["1, one", "2"]]);
  });
  it("keeps commas inside quoted TSV headers from flipping the delimiter", () => {
    expect(parseCsv('"x,y"\tz\n1\t2')).toEqual([["x,y", "z"], ["1", "2"]]);
  });
  it("keeps empty cells, drops blank lines and BOM", () => {
    expect(parseCsv("﻿a,b,c\n\n1,,3\n,,\n")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });
  it("treats a quote in the middle of a cell literally", () => {
    expect(parseCsv('size\n5" screen')).toEqual([["size"], ['5" screen']]);
  });
  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\r\n")).toEqual([]);
  });
});

describe("detectType", () => {
  it("numbers", () => expect(detectType(["1", "2.5", "-3", "1,200", ""])).toBe("number"));
  it("percent → progress", () => expect(detectType(["10%", "55%", "100%"])).toBe("progress"));
  it("booleans", () => expect(detectType(["true", "False", "yes", "no"])).toBe("checkbox"));
  it("dates", () => expect(detectType(["2026-11-04", "2026-12-01"])).toBe("date"));
  it("urls", () => expect(detectType(["https://a.com", "http://b.org/x"])).toBe("url"));
  it("tags when values are ;-lists", () => expect(detectType(["API; Infra", "API", "Docs"])).toBe("tags"));
  it("select for repeated small vocab", () => expect(detectType(["High", "Low", "High", "Medium"])).toBe("select"));
  it("status when the header says so", () => expect(detectType(["Done", "Doing", "Done"], "Status")).toBe("status"));
  it("text otherwise", () => expect(detectType(["alpha", "beta", "gamma"])).toBe("text"));
  it("text for an all-empty column", () => expect(detectType(["", " "])).toBe("text"));
  it("first column is always title; person detected from users", () => {
    const users = [{ id: "u1", name: "Asha Rao", color: "#000" }];
    const f = detectFields([["Name", "Owner"], ["x", "Asha Rao"], ["y", ""]], users);
    expect(f.map((x) => x.type)).toEqual(["title", "person"]);
    expect(coerce("asha rao", "person", users)).toBe("u1");
  });
  it("assigns option tones", () => {
    const f = detectFields([["T", "Status"], ["a", "Done"], ["b", "In progress"], ["c", "Done"]]);
    expect(f[1].type).toBe("status");
    expect(f[1].options).toEqual([{ v: "Done", c: "green" }, { v: "In progress", c: "blue" }]);
  });
});

describe("CSV import / export", () => {
  const CSV = [
    "Name,Status,Votes,Requested,Done,Link,Area,Progress,Note",
    'Per-channel autosave,Planned,42,2026-11-02,true,https://a.example.com/x,API; Infra,40%,"has, comma"',
    'Comments in PDF export,In progress,31,2026-10-28,false,https://a.example.com/y,API,60%,"say ""hi"""',
    "Offline mode,Planned,27.5,2026-11-10,false,,Docs,0%,",
    "Formulas,Shipped,,2026-11-18,true,https://a.example.com/z,,100%,multi word",
  ].join("\n");

  it("detects types on import", () => {
    const doc = new Y.Doc();
    const id = importCsvToDatabase(doc, CSV, "Feedback");
    const db = snap(doc, id);
    expect(db.name).toBe("Feedback");
    expect(db.fields.map((f) => f.type)).toEqual(["title", "status", "number", "date", "checkbox", "url", "tags", "progress", "text"]);
    expect(db.rows).toHaveLength(4);
    expect(db.rows[0].v[db.fields[2].id]).toBe(42);
    expect(db.rows[0].v[db.fields[6].id]).toEqual(["API", "Infra"]);
    expect(db.rows[2].v[db.fields[2].id]).toBe(27.5);
    expect(db.rows[3].v[db.fields[2].id]).toBeNull();
    expect(db.rows[1].v[db.fields[8].id]).toBe('say "hi"');
  });

  it("round-trips import → export", () => {
    const doc = new Y.Doc();
    const id = importCsvToDatabase(doc, CSV);
    expect(databaseToCsv(doc, id)).toBe(CSV);
  });

  it("round-trips CRLF and tab input to canonical CSV", () => {
    const doc = new Y.Doc();
    const tsv = "Name\tCount\r\nA\t1\r\nB\t2\r\n";
    const id = importCsvToDatabase(doc, tsv);
    expect(databaseToCsv(doc, id)).toBe("Name,Count\nA,1\nB,2");
    // and the exported text re-imports identically
    const id2 = importCsvToDatabase(doc, databaseToCsv(doc, id));
    expect(databaseToCsv(doc, id2)).toBe(databaseToCsv(doc, id));
  });

  it("exports preset person cells as names", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "actions");
    const lines = databaseToCsv(doc, id).split("\n");
    expect(lines[0]).toBe("Action,Owner,Due,Done");
    expect(lines[1]).toBe("Send recap to the channel,Priya Shah,2026-11-21,true");
  });

  it("appendCsv matches columns by name and adds unknown ones", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "kanban");
    const n = appendCsv(doc, id, "Card,Status,Budget\nShip it,Blocked,12\nPlan,Done,3");
    expect(n).toBe(2);
    const db = snap(doc, id);
    expect(db.rows).toHaveLength(6);
    const st = db.fields.find((f) => f.name === "Status")!;
    expect(st.options!.map((o) => o.v)).toContain("Blocked");
    const budget = db.fields.find((f) => f.name === "Budget")!;
    expect(budget.type).toBe("number");
    expect(db.rows[4].v[budget.id]).toBe(12);
  });
});

describe("createDatabase presets", () => {
  it.each(DB_PRESETS)("%s produces valid fields and rows", (p) => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, p);
    const m = getDbMap(doc, id)!;
    // Y layout from the build contract
    expect(m.get("fields")).toBeInstanceOf(Y.Array);
    expect(m.get("order")).toBeInstanceOf(Y.Array);
    expect(m.get("rows")).toBeInstanceOf(Y.Map);
    expect(m.get("notes")).toBeInstanceOf(Y.Map);
    expect(m.get("views")).toBeInstanceOf(Y.Map);
    expect(typeof m.get("view")).toBe("string");
    const db = snap(doc, id);
    const def = PRESETS[p];
    expect(db.name).toBe(def.name);
    expect(db.fields.length).toBe(def.fields.length);
    expect(db.fields[0].type).toBe("title");
    expect(new Set(db.fields.map((f) => f.id)).size).toBe(db.fields.length);
    for (const f of db.fields) {
      expect(FIELD_TYPES).toContain(f.type);
      if (f.type === "status" || f.type === "select" || f.type === "tags") expect(f.options!.length).toBeGreaterThan(0);
    }
    expect(db.rows.length).toBe(def.rows.length);
    for (const r of db.rows) {
      for (const f of db.fields) {
        const v = r.v[f.id];
        expect(f.id in r.v).toBe(true);
        if (v == null) continue;
        if (f.type === "status" || f.type === "select") expect(f.options!.map((o) => o.v)).toContain(v);
        if (f.type === "tags") for (const t of v as string[]) expect(f.options!.map((o) => o.v)).toContain(t);
        if (f.type === "date") expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (f.type === "number" || f.type === "progress") expect(typeof v).toBe("number");
        if (f.type === "checkbox") expect(typeof v).toBe("boolean");
      }
    }
    expect((m.get("order") as Y.Array<string>).length).toBe(db.rows.length);
  });
});

describe("mutations", () => {
  it("add / delete / restore row and field", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    const rid = addRow(doc, id, {});
    expect(snap(doc, id).rows.at(-1)!.id).toBe(rid);
    const b = deleteRow(doc, id, snap(doc, id).rows[1].id)!;
    expect(snap(doc, id).rows).toHaveLength(7);
    restoreRow(doc, id, b);
    expect(snap(doc, id).rows[1].id).toBe(b.id);
    const fid = addField(doc, id, "checkbox");
    expect(snap(doc, id).rows.every((r) => r.v[fid] === false)).toBe(true);
    const fb = deleteField(doc, id, "pts")!;
    expect(snap(doc, id).fields.some((f) => f.id === "pts")).toBe(false);
    restoreField(doc, id, fb);
    expect(snap(doc, id).fields[4].id).toBe("pts");
    expect(snap(doc, id).rows[0].v.pts).toBe(2);
  });

  it("filters, searches and sorts from shared view prefs", () => {
    const doc = new Y.Doc();
    const id = createDatabase(doc, "tasks");
    setPrefs(doc, id, "table", { filter: { f: "status", vals: ["In progress"] }, sort: { f: "pts", dir: -1 } });
    const db = snap(doc, id);
    const rows = visibleRows(db, db.views.table, []);
    expect(rows.map((r) => r.v.pts)).toEqual([8, 5, 3]);
    setPrefs(doc, id, "table", { q: "wal" });
    const db2 = snap(doc, id);
    expect(visibleRows(db2, db2.views.table, []).map((r) => r.v.title)).toEqual(["Room WAL compaction every 500 updates"]);
  });
});

describe("collaboration", () => {
  function pair() {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(b, u, "remote"));
    b.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(a, u, "remote"));
    return [a, b] as const;
  }

  it("two docs converge on a cell edit", () => {
    const [a, b] = pair();
    const id = createDatabase(a, "tasks");
    const rid = snap(b, id).rows[0].id;
    setCell(b, id, rid, "status", "In review");
    setCell(a, id, rid, "title", "Renamed on A");
    expect(snap(a, id).rows[0].v).toEqual(snap(b, id).rows[0].v);
    expect(snap(a, id).rows[0].v.status).toBe("In review");
    expect(snap(b, id).rows[0].v.title).toBe("Renamed on A");
  });

  it("concurrent edits converge after offline merge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const id = createDatabase(a, "kanban");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const rid = snap(a, id).rows[0].id;
    setCell(a, id, rid, "status", "Doing");
    setCell(b, id, rid, "status", "Review");
    addRow(a, id, { title: "from A" });
    addRow(b, id, { title: "from B" });
    deleteRow(b, id, snap(b, id).rows[1].id);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(snap(a, id)).toEqual(snap(b, id));
    expect(snap(a, id).rows).toHaveLength(5);
  });
});
