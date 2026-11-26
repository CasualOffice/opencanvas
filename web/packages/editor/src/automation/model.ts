// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Automation rules in the editor (AUTO-06, ADR-067, docs/34 §5.3): read and write the
// `automations` root, describe a rule as a sentence with the canvas's own names, check it the
// way the server will, and suggest rules for this canvas. The server enforces everything again
// (perms.automate, owner, limits, origins); this is for showing it before saving.
import * as Y from "yjs";

export const AUTOMATION_ORIGIN = { source: "@opencanvas/automation" };

export type Trigger =
  | { kind: "row.added"; database: string }
  | { kind: "field.changed"; database: string; field: string; to?: unknown }
  | { kind: "date.reached"; database: string; field: string; offsetDays: number; time: string }
  | { kind: "checklist.checked"; block?: string }
  | { kind: "comment.added" }
  | { kind: "mention.added" }
  | { kind: "schedule"; every: "day" | "week" | "month" | "minutes"; time?: string; weekday?: number; monthday?: number; minutes?: number };

export interface Condition {
  field: string;
  op: string;
  value?: unknown;
}

export type Action =
  | { kind: "field.set"; field: string; value: unknown }
  | { kind: "row.move"; to: { database: string } }
  | { kind: "todo.set"; block?: string; checked: boolean }
  | { kind: "todo.add"; items: string[]; heading?: string; after?: string }
  | { kind: "comment.add"; text: string }
  | { kind: "notify"; people: string[]; text: string }
  | { kind: "http.post"; url: string; fields: string[] };

export interface Rule {
  id: string;
  v?: number;
  name: string;
  enabled: boolean;
  ownerId?: string;
  ownerName?: string;
  updatedAt?: string;
  timeZone?: string;
  trigger: Trigger | null;
  match?: "all" | "any";
  conditions: Condition[];
  actions: Action[];
  paused?: { code: string; at?: string } | null;
}

export interface Limits {
  maxRules: number;
  maxChanges: number;
  minIntervalMin: number;
  timeZone: string;
  actions: string[];
  origins: string[];
}

export interface Field {
  id: string;
  name: string;
  type: string;
  options: string[];
}
export interface Db {
  id: string;
  name: string;
  fields: Field[];
}

export const OPS: [string, string][] = [
  ["is", "is"],
  ["isNot", "is not"],
  ["contains", "contains"],
  ["notContains", "does not contain"],
  ["isEmpty", "is empty"],
  ["isNotEmpty", "is not empty"],
  ["before", "is before"],
  ["after", "is after"],
];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function newRuleId(): string {
  return "au_" + Math.random().toString(36).slice(2, 10);
}

export function readRules(doc: Y.Doc): Rule[] {
  const root = doc.getMap("automations");
  const out: Rule[] = [];
  root.forEach((v, id) => {
    const o = (v instanceof Y.Map ? v.toJSON() : v) as Record<string, unknown>;
    if (!o || typeof o !== "object") return;
    out.push({
      id,
      v: typeof o.v === "number" ? o.v : 1,
      name: str(o.name),
      enabled: o.enabled === true,
      ownerId: str(o.ownerId) || undefined,
      ownerName: str(o.ownerName) || undefined,
      updatedAt: str(o.updatedAt) || undefined,
      timeZone: str(o.timeZone) || undefined,
      trigger: (o.trigger as Trigger) ?? null,
      match: o.match === "any" ? "any" : "all",
      conditions: Array.isArray(o.conditions) ? (o.conditions as Condition[]) : [],
      actions: Array.isArray(o.actions) ? (o.actions as Action[]) : [],
      paused: (o.paused as Rule["paused"]) ?? null,
    });
  });
  return out.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "") || a.id.localeCompare(b.id));
}

export function readDbs(doc: Y.Doc): Db[] {
  const out: Db[] = [];
  doc.getMap("databases").forEach((v, id) => {
    if (!(v instanceof Y.Map)) return;
    const raw = v.get("fields");
    const list = raw instanceof Y.Array ? raw.toArray() : Array.isArray(raw) ? raw : [];
    const fields = list.map((f) => {
      const o = (f instanceof Y.Map ? f.toJSON() : f) as Record<string, unknown>;
      let opts = o.options as unknown;
      if (typeof opts === "string") {
        try {
          opts = JSON.parse(opts);
        } catch {
          opts = [];
        }
      }
      const options = Array.isArray(opts) ? opts.map((x) => (typeof x === "string" ? x : str((x as { v?: unknown })?.v))).filter(Boolean) : [];
      return { id: str(o.id), name: str(o.name) || "Field", type: str(o.type), options };
    });
    out.push({ id, name: str(v.get("name")) || "Database", fields });
  });
  return out;
}

/** Checklist items and lists with ids, for "When this is checked…". */
export function readChecklists(doc: Y.Doc): { id: string; text: string; list?: string }[] {
  const out: { id: string; text: string; list?: string }[] = [];
  const walk = (n: Y.XmlElement | Y.XmlFragment, list?: string) => {
    for (const c of n.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      const id = c.getAttribute("blockId") as string | undefined;
      if (c.nodeName === "taskItem" && id) out.push({ id, text: c.toString().replace(/<[^>]+>/g, "").slice(0, 80), list });
      walk(c, c.nodeName === "taskList" ? (id ?? list) : list);
    }
  };
  walk(doc.getXmlFragment("content"));
  return out;
}

export const fieldOf = (db: Db | undefined, key: string) => db?.fields.find((f) => f.id === key) ?? db?.fields.find((f) => f.name.toLowerCase() === key.toLowerCase());

export function writeRule(doc: Y.Doc, r: Rule, me: { id: string; name: string }) {
  const root = doc.getMap("automations");
  doc.transact(() => {
    let m = root.get(r.id);
    if (!(m instanceof Y.Map)) {
      m = new Y.Map();
      root.set(r.id, m);
    }
    const map = m as Y.Map<unknown>;
    const fields: Record<string, unknown> = {
      v: 1,
      name: r.name.trim() || "New rule",
      enabled: r.enabled,
      ownerId: me.id,
      ownerName: me.name,
      updatedAt: new Date().toISOString(),
      trigger: r.trigger,
      match: r.match ?? "all",
      conditions: r.conditions,
      actions: r.actions,
    };
    if (r.timeZone) fields.timeZone = r.timeZone;
    for (const [k, v] of Object.entries(fields)) map.set(k, v);
    if (map.has("paused")) map.delete("paused");
  }, AUTOMATION_ORIGIN);
}

/** On makes you the owner ("Runs as you from now on"); off leaves the owner. */
export function setEnabled(doc: Y.Doc, id: string, on: boolean, me: { id: string; name: string }) {
  const m = doc.getMap("automations").get(id);
  if (!(m instanceof Y.Map)) return;
  doc.transact(() => {
    m.set("enabled", on);
    if (on) {
      m.set("ownerId", me.id);
      m.set("ownerName", me.name);
      m.set("updatedAt", new Date().toISOString());
      if (m.has("paused")) m.delete("paused");
    }
  }, AUTOMATION_ORIGIN);
}

export function deleteRule(doc: Y.Doc, id: string) {
  doc.transact(() => doc.getMap("automations").delete(id), AUTOMATION_ORIGIN);
}

// ---------- the sentence ----------

/** A piece of the sentence: words, or a token (a name from the canvas). */
export type Part = string | { tok: string; db?: boolean; mono?: boolean; bad?: boolean };

const tok = (t: string, o: { db?: boolean; mono?: boolean; bad?: boolean } = {}): Part => ({ tok: t, ...o });
const val = (v: unknown) => (v == null || v === "" ? "any value" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? str((v as { v?: unknown }).v) : String(v));

export function urlLabel(u: string): string {
  try {
    const x = new URL(u);
    return x.host + (x.pathname === "/" ? "" : x.pathname);
  } catch {
    return u;
  }
}

function at(time?: string) {
  return time || "09:00";
}

export function whenParts(t: Trigger | null, dbs: Db[], lists: { id: string; text: string }[] = []): Part[] {
  if (!t) return ["Choose a trigger"];
  const db = "database" in t ? dbs.find((d) => d.id === t.database) : undefined;
  const dbTok = (id: string) => tok(db?.name ?? "a deleted database", { db: true, bad: !db && !!id });
  switch (t.kind) {
    case "row.added":
      return ["a row is added to", dbTok(t.database)];
    case "field.changed": {
      const f = fieldOf(db, t.field);
      const p: Part[] = [tok(f?.name ?? t.field, { bad: !f }), t.to != null && t.to !== "" ? "changes to" : "changes"];
      if (t.to != null && t.to !== "") p.push(tok(val(t.to), { bad: !!f?.options.length && !f.options.includes(val(t.to)) }));
      return [...p, "in", dbTok(t.database)];
    }
    case "date.reached": {
      const f = fieldOf(db, t.field);
      const n = Math.abs(t.offsetDays);
      const rel = t.offsetDays === 0 ? "is today" : t.offsetDays < 0 ? `is ${n} ${n === 1 ? "day" : "days"} away` : `was ${n} ${n === 1 ? "day" : "days"} ago`;
      return [tok(f?.name ?? t.field, { bad: !f }), `${rel}, at`, tok(at(t.time))];
    }
    case "checklist.checked": {
      if (!t.block) return ["an item in a checklist is checked"];
      const item = lists.find((l) => l.id === t.block);
      return item ? ["the item", tok(item.text || "item"), "is checked"] : ["an item in", tok("a checklist"), "is checked"];
    }
    case "comment.added":
      return ["a comment is added"];
    case "mention.added":
      return ["someone is mentioned in a comment"];
    case "schedule":
      if (t.every === "minutes") return ["every", tok(`${t.minutes ?? 15} minutes`)];
      if (t.every === "week") return ["every", tok(WEEKDAYS[t.weekday ?? 1]), "at", tok(at(t.time))];
      if (t.every === "month") return ["on day", tok(String(t.monthday ?? 1)), "of every month at", tok(at(t.time))];
      return ["every day at", tok(at(t.time))];
  }
}

export function conditionParts(c: Condition, db: Db | undefined): Part[] {
  const f = fieldOf(db, c.field);
  const op = OPS.find((o) => o[0] === c.op)?.[1] ?? c.op;
  const p: Part[] = [tok(f?.name ?? c.field, { bad: !f }), op];
  if (!["isEmpty", "isNotEmpty"].includes(c.op)) p.push(tok(val(c.value)));
  return p;
}

export function actionParts(a: Action, db: Db | undefined, dbs: Db[], person: (id: string) => string): Part[] {
  switch (a.kind) {
    case "field.set": {
      const f = fieldOf(db, a.field);
      return ["set", tok(f?.name ?? a.field, { bad: !f }), "to", tok(a.value === "today" ? "today" : val(a.value))];
    }
    case "row.move": {
      const to = dbs.find((d) => d.id === a.to.database);
      return ["move the row to", tok(to?.name ?? "a deleted database", { db: true, bad: !to })];
    }
    case "todo.set":
      return [a.checked ? "check the item" : "uncheck the item"];
    case "todo.add":
      return ["add the checklist", tok(a.heading || `${a.items.length} items`)];
    case "comment.add":
      return ["comment", `“${a.text}”`];
    case "notify":
      return ["notify", ...a.people.flatMap((p, i) => [...(i ? [", "] : []), tok(p.startsWith("field:") ? fieldOf(db, p.slice(6))?.name ?? p.slice(6) : person(p))])];
    case "http.post":
      return ["call", tok(urlLabel(a.url), { mono: true })];
  }
}

// ---------- checks (as the server checks on save and every run) ----------

export function originAllowed(url: string, origins: string[]): boolean {
  try {
    return origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/** What to fix before the rule can be saved or run, in words. */
export function issues(r: Rule, dbs: Db[], limits: Limits): string[] {
  const out: string[] = [];
  const t = r.trigger;
  if (!t) out.push("Choose a trigger.");
  const db = t && "database" in t ? dbs.find((d) => d.id === t.database) : undefined;
  if (t && "database" in t) {
    if (!db) out.push("The database this rule watches was deleted from this canvas. Pick another database.");
    if ((t.kind === "field.changed" || t.kind === "date.reached") && db && !fieldOf(db, t.field)) out.push(`The field “${t.field}” no longer exists in ${db.name}. Pick another field.`);
    if (t.kind === "field.changed" && db && t.to != null && t.to !== "") {
      const f = fieldOf(db, t.field);
      if (f?.options.length && !f.options.includes(val(t.to))) out.push(`“${val(t.to)}” is no longer an option of ${f.name}. Pick another, or add it back.`);
    }
  }
  if (t?.kind === "schedule" && t.every === "minutes" && (t.minutes ?? 0) < limits.minIntervalMin) out.push(`Schedules run at most every ${limits.minIntervalMin} minutes.`);
  if (!r.actions.length) out.push("Add an action.");
  for (const a of r.actions) {
    if (!limits.actions.includes(a.kind)) out.push(`This host does not allow the action “${a.kind}”.`);
    if (a.kind === "row.move") {
      const to = dbs.find((d) => d.id === a.to.database);
      if (!to) out.push("The database the row moves to was deleted from this canvas. Pick another database.");
      else if (db && to.id === db.id) out.push("A row moves to another database.");
    }
    if (a.kind === "http.post" && !originAllowed(a.url, limits.origins)) {
      out.push(`This URL isn’t allowed. Automations here may call ${limits.origins.map((o) => new URL(o).host).join(" or ")}.`);
    }
    if ((a.kind === "notify" && !a.people.length) || (a.kind === "todo.add" && !a.items.filter((i) => i.trim()).length)) out.push("Finish the action.");
    if ((a.kind === "row.move" || a.kind === "field.set") && !db) out.push("Moving or setting a field needs a trigger in a database.");
  }
  for (const c of r.conditions) if (db && !fieldOf(db, c.field)) out.push(`The field “${c.field}” in a condition no longer exists.`);
  return [...new Set(out)];
}

// ---------- suggestions (frame 1b) ----------

export interface Suggestion {
  title: string;
  where: string;
  rule: Rule;
}

const blank = (): Rule => ({ id: newRuleId(), name: "", enabled: true, trigger: null, match: "all", conditions: [], actions: [] });

export function suggestions(dbs: Db[], hasChecklist: boolean): Suggestion[] {
  const out: Suggestion[] = [];
  for (const db of dbs) {
    const status = db.fields.find((f) => (f.type === "status" || f.type === "select") && f.options.some((o) => /done|complete/i.test(o)));
    const other = dbs.find((d) => d.id !== db.id);
    const owner = db.fields.find((f) => f.type === "person");
    if (status && other) {
      const done = status.options.find((o) => /done|complete/i.test(o))!;
      out.push({
        title: `When ${status.name} is ${done}, move the row to ${other.name}`,
        where: db.name,
        rule: { ...blank(), name: "Move done items", trigger: { kind: "field.changed", database: db.id, field: status.id, to: done }, actions: [{ kind: "row.move", to: { database: other.id } }] },
      });
    }
    const due = db.fields.find((f) => f.type === "date");
    if (due && owner) {
      out.push({
        title: `The day before ${due.name}, notify the ${owner.name}`,
        where: db.name,
        rule: { ...blank(), name: `${due.name} tomorrow reminder`, trigger: { kind: "date.reached", database: db.id, field: due.id, offsetDays: -1, time: "09:00" }, actions: [{ kind: "notify", people: [`field:${owner.id}`], text: "{row.title} is due tomorrow" }] },
      });
    }
    if (out.length >= 2) break;
  }
  out.push({
    title: "Every Monday at 09:00, add a check-in checklist",
    where: "Schedule",
    rule: { ...blank(), name: "Monday check-in", trigger: { kind: "schedule", every: "week", weekday: 1, time: "09:00" }, actions: [{ kind: "todo.add", heading: "Monday check-in", items: ["Blockers raised in stand-up", "Backlog groomed for the week", "Due dates checked"] }] },
  });
  if (!dbs.length && !hasChecklist) {
    out.push({ title: "When a comment is added, add a reply", where: "Comments", rule: { ...blank(), name: "Acknowledge comments", trigger: { kind: "comment.added" }, actions: [{ kind: "comment.add", text: "Thanks, we will look at this." }] } });
  }
  return out.slice(0, 3);
}

export const blankRule = blank;

// ---------- times (status line) ----------

function partsIn(tz: string, d: Date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { y: +g("year"), m: +g("month"), d: +g("day"), h: +g("hour"), min: +g("minute"), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
}

/** A safe time zone name for Intl (`UTC+01:00` → `Etc/GMT-1`; unknown → UTC). */
export function intlZone(tz: string): string {
  const m = /^UTC([+-])(\d{1,2})(?::00)?$/.exec(tz);
  if (m) return `Etc/GMT${m[1] === "+" ? "-" : "+"}${+m[2]}`;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** The next run of a date or schedule rule (approximate to the minute, for the status line). */
export function nextRun(t: Trigger | null, tz: string, now = new Date()): Date | null {
  if (!t || (t.kind !== "schedule" && t.kind !== "date.reached")) return null;
  const zone = intlZone(tz);
  if (t.kind === "schedule" && t.every === "minutes") {
    const ms = Math.max(15, t.minutes ?? 15) * 60_000;
    return new Date(Math.ceil((now.getTime() + 1) / ms) * ms);
  }
  const [hh, mm] = at(t.kind === "schedule" ? t.time : t.time).split(":").map(Number);
  for (let i = 0; i < 40; i++) {
    const day = new Date(now.getTime() + i * 86_400_000);
    const p = partsIn(zone, day);
    if (t.kind === "schedule" && t.every === "week" && p.wd !== (t.weekday ?? 1)) continue;
    if (t.kind === "schedule" && t.every === "month" && p.d !== (t.monthday ?? 1)) continue;
    // The wall time in the zone, found by correcting with the zone's offset at that moment.
    const guess = Date.UTC(p.y, p.m - 1, p.d, hh, mm);
    const q = partsIn(zone, new Date(guess));
    const off = Date.UTC(q.y, q.m - 1, q.d, q.h, q.min) - guess;
    const when = new Date(guess - off);
    if (when.getTime() > now.getTime()) return when;
  }
  return null;
}

export function fmtNext(d: Date, tz: string): string {
  const zone = intlZone(tz);
  const s = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const city = tz.includes("/") ? tz.split("/").pop()!.replace(/_/g, " ") : tz;
  return `Next: ${s} (${city})`;
}

export interface Run {
  id: string;
  ruleId: string;
  trigger: string;
  result: "running" | "done" | "skipped" | "failed" | "stopped";
  errorCode: string;
  httpStatus: number;
  changes: number;
  notified: number;
  depth: number;
  durationMs: number;
  at: number;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The words of a run's outcome (frame 4a). */
export function outcome(r: Run): string {
  const ms = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)} s` : `${r.durationMs} ms`;
  if (r.result === "done") {
    const p = [r.changes ? `${r.changes} ${r.changes === 1 ? "change" : "changes"}` : "", r.notified ? `${r.notified} ${r.notified === 1 ? "notification" : "notifications"}` : "", r.httpStatus ? `URL answered ${r.httpStatus}` : ""].filter(Boolean);
    return `${p.join(" · ") || "Nothing to change"} · ${ms}`;
  }
  const why: Record<string, string> = {
    MAX_DEPTH: "Stopped: 3 rules deep",
    LOOP: "Stopped: a rule would trigger itself",
    MAX_CHANGES: "Stopped: more than the allowed changes in one run",
    OWNER_NO_EDIT: "Skipped: the person it runs for has no edit access",
    STALE_OWNER: "Skipped: the person it runs for has not opened this canvas for 30 days",
    LIMIT_PER_MINUTE: "Skipped: too many runs this minute",
    LIMIT_PER_DAY: "Skipped: this canvas reached its daily runs",
    PAUSED: "Skipped: the rule is paused",
    RULE_OFF: "Skipped: the rule is off",
    NO_MATCH: "Skipped: nothing matched",
    URL_UNREACHABLE: "The URL did not answer",
    URL_NOT_ALLOWED: "The URL is not allowed",
    NOTIFY_FAILED: "The host did not take the notification",
    FILE_UNAVAILABLE: "The canvas could not be opened",
    RULE_BROKEN: "The rule points at something that no longer exists",
    WRITE_FAILED: "The change could not be made",
  };
  const cond = /^CONDITION_(\d+)$/.exec(r.errorCode);
  const text = cond ? `Skipped: condition ${cond[1]} did not hold` : /^URL_\d+$/.test(r.errorCode) ? `URL answered ${r.httpStatus || r.errorCode.slice(4)}` : why[r.errorCode] ?? (r.errorCode || r.result);
  return `${text} · ${ms}`;
}
