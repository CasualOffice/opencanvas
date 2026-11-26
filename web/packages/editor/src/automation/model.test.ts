// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { actionParts, deleteRule, fmtNext, issues, nextRun, outcome, readDbs, readRules, setEnabled, suggestions, whenParts, writeRule, type Limits, type Part, type Rule } from "./model";

const limits: Limits = { maxRules: 25, maxChanges: 50, minIntervalMin: 15, timeZone: "Europe/Berlin", actions: ["field.set", "row.move", "todo.set", "todo.add", "comment.add", "notify", "http.post"], origins: ["https://docs.acme.example"] };

function canvas() {
  const doc = new Y.Doc();
  const add = (id: string, name: string, fields: [string, string, string, string[]?][]) => {
    const db = new Y.Map<unknown>();
    doc.getMap("databases").set(id, db);
    db.set("name", name);
    const fs = new Y.Array<Y.Map<unknown>>();
    for (const [fid, fname, type, options] of fields) {
      const f = new Y.Map<unknown>();
      f.set("id", fid);
      f.set("name", fname);
      f.set("type", type);
      if (options) f.set("options", options.map((v) => ({ v })));
      fs.push([f]);
    }
    db.set("fields", fs);
  };
  add("db_1", "Sprint 42 backlog", [["t", "Task", "title"], ["s", "Status", "status", ["In review", "Done"]], ["o", "Owner", "person"], ["d", "Due", "date"]]);
  add("db_a", "Archive", [["x", "Task", "title"]]);
  return doc;
}
const words = (p: Part[]) => p.map((x) => (typeof x === "string" ? x : `[${x.tok}${x.bad ? "!" : ""}]`)).join(" ");

describe("automation rules in the editor", () => {
  it("writes, reads, switches and deletes a rule; the saver becomes its owner", () => {
    const doc = canvas();
    const s = suggestions(readDbs(doc), false);
    expect(s[0].title).toBe("When Status is Done, move the row to Archive");
    expect(s[1].title).toBe("The day before Due, notify the Owner");
    expect(s[2].title).toBe("Every Monday at 09:00, add a check-in checklist");
    writeRule(doc, s[0].rule, { id: "u_lea", name: "Lea" });
    let r = readRules(doc);
    expect(r).toHaveLength(1);
    expect(r[0].ownerId).toBe("u_lea");
    expect(r[0].enabled).toBe(true);
    setEnabled(doc, r[0].id, false, { id: "u_jonas", name: "Jonas" });
    expect(readRules(doc)[0].ownerId).toBe("u_lea");
    setEnabled(doc, r[0].id, true, { id: "u_jonas", name: "Jonas" });
    r = readRules(doc);
    expect(r[0].ownerId).toBe("u_jonas");
    deleteRule(doc, r[0].id);
    expect(readRules(doc)).toHaveLength(0);
  });

  it("reads as a sentence with the canvas's names and marks what is broken", () => {
    const dbs = readDbs(canvas());
    expect(words(whenParts({ kind: "field.changed", database: "db_1", field: "s", to: "Done" }, dbs))).toBe("[Status] changes to [Done] in [Sprint 42 backlog]");
    expect(words(whenParts({ kind: "field.changed", database: "db_1", field: "s", to: "Blocked" }, dbs))).toBe("[Status] changes to [Blocked!] in [Sprint 42 backlog]");
    expect(words(whenParts({ kind: "date.reached", database: "db_1", field: "d", offsetDays: -1, time: "09:00" }, dbs))).toBe("[Due] is 1 day away, at [09:00]");
    expect(words(whenParts({ kind: "schedule", every: "week", weekday: 1, time: "09:00" }, dbs))).toBe("every [Monday] at [09:00]");
    expect(words(actionParts({ kind: "notify", people: ["field:o"], text: "x" }, dbs[0], dbs, (id) => id))).toBe("notify [Owner]");
    expect(words(actionParts({ kind: "row.move", to: { database: "db_gone" } }, dbs[0], dbs, (id) => id))).toBe("move the row to [a deleted database!]");
  });

  it("checks what the server checks: references, options, origins, schedules", () => {
    const dbs = readDbs(canvas());
    const r: Rule = { id: "au_1", name: "Move blocked work", enabled: true, trigger: { kind: "field.changed", database: "db_1", field: "Status", to: "Blocked" }, conditions: [], actions: [{ kind: "row.move", to: { database: "db_parking" } }] };
    const e = issues(r, dbs, limits);
    expect(e).toContain("“Blocked” is no longer an option of Status. Pick another, or add it back.");
    expect(e).toContain("The database the row moves to was deleted from this canvas. Pick another database.");
    const url = issues({ ...r, trigger: { kind: "checklist.checked" }, actions: [{ kind: "http.post", url: "https://hooks.slack-mirror.example/rel", fields: [] }] }, dbs, limits);
    expect(url[0]).toBe("This URL isn’t allowed. Automations here may call docs.acme.example.");
    expect(issues({ ...r, trigger: { kind: "schedule", every: "minutes", minutes: 5 }, actions: [{ kind: "comment.add", text: "x" }] }, dbs, limits)).toEqual(["Schedules run at most every 15 minutes."]);
    expect(issues({ ...r, trigger: { kind: "field.changed", database: "db_1", field: "Status", to: "Done" }, actions: [{ kind: "row.move", to: { database: "db_a" } }] }, dbs, limits)).toEqual([]);
  });

  it("knows the next run and words a run's outcome", () => {
    const now = new Date("2026-11-26T10:00:00Z");
    const n = nextRun({ kind: "date.reached", database: "d", field: "f", offsetDays: -1, time: "09:00" }, "Europe/Berlin", now)!;
    expect(n.toISOString()).toBe("2026-11-27T08:00:00.000Z");
    expect(fmtNext(n, "Europe/Berlin")).toBe("Next: Nov 27, 09:00 (Berlin)");
    const mon = nextRun({ kind: "schedule", every: "week", weekday: 1, time: "09:00" }, "Europe/Berlin", now)!;
    expect(mon.toISOString()).toBe("2026-11-30T08:00:00.000Z");
    const run = { id: "r", ruleId: "a", trigger: "field.changed", result: "done", errorCode: "", httpStatus: 0, changes: 2, notified: 1, depth: 0, durationMs: 180, at: 0 } as const;
    expect(outcome(run)).toBe("2 changes · 1 notification · 180 ms");
    expect(outcome({ ...run, result: "stopped", errorCode: "MAX_DEPTH", durationMs: 40 })).toBe("Stopped: 3 rules deep · 40 ms");
    expect(outcome({ ...run, result: "failed", errorCode: "URL_502", httpStatus: 502, durationMs: 10_000 })).toBe("URL answered 502 · 10.0 s");
    expect(outcome({ ...run, result: "skipped", errorCode: "CONDITION_2", durationMs: 12 })).toBe("Skipped: condition 2 did not hold · 12 ms");
  });
});
