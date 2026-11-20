import * as Y from "yjs";
import type { OcUser, Tone } from "@opencanvas/ui";
import { coerce, detectFields, parseCsv, toCsv, toneFor } from "./csv";
import { DEMO_PEOPLE, PRESETS, type DbPreset } from "./presets";
import type { CellValue, DbField, DbOption, DbRow, DbSnapshot, FieldType, ViewKind, ViewPrefs } from "./types";
import { VIEW_KINDS } from "./types";

/** Transaction origin for every local database mutation. */
export const DB_ORIGIN = { source: "@opencanvas/database" };

export const nid = (p: string) => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);

export function databasesRoot(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("databases") as Y.Map<Y.Map<unknown>>;
}

export function getDbMap(doc: Y.Doc, dbId: string): Y.Map<unknown> | null {
  const m = databasesRoot(doc).get(dbId);
  return m instanceof Y.Map ? m : null;
}

const emptyValue = (t: FieldType): CellValue => (t === "tags" ? [] : t === "checkbox" ? false : null);

function fieldToY(f: DbField): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", f.id);
  m.set("name", f.name);
  m.set("type", f.type);
  m.set("options", f.options ? f.options.map((o) => ({ v: o.v, c: o.c })) : null);
  return m;
}

function rowToY(fields: DbField[], v: Record<string, CellValue>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const f of fields) {
    const x = v[f.id];
    m.set(f.id, x === undefined ? emptyValue(f.type) : Array.isArray(x) ? x.slice() : x);
  }
  return m;
}

interface NewDb {
  name: string;
  icon: string;
  tone: Tone;
  view?: ViewKind;
  fields: DbField[];
  rows: Record<string, CellValue>[];
}

function writeDb(doc: Y.Doc, d: NewDb): string {
  const id = nid("d");
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    databasesRoot(doc).set(id, m);
    m.set("name", d.name);
    m.set("icon", d.icon);
    m.set("tone", d.tone);
    m.set("view", d.view ?? "table");
    const fields = new Y.Array<Y.Map<unknown>>();
    m.set("fields", fields);
    fields.push(d.fields.map(fieldToY));
    const order = new Y.Array<string>();
    const rows = new Y.Map<Y.Map<unknown>>();
    const notes = new Y.Map<string>();
    m.set("order", order);
    m.set("rows", rows);
    m.set("notes", notes);
    m.set("views", new Y.Map<unknown>());
    const ids: string[] = [];
    for (const r of d.rows) {
      const rid = nid("r");
      ids.push(rid);
      rows.set(rid, rowToY(d.fields, r));
    }
    order.push(ids);
  }, DB_ORIGIN);
  return id;
}

/**
 * How preset sample people map onto real users: an id the host knows is kept; every other
 * sample person takes the next real user (in `users` order, skipping users already matched
 * by id, wrapping when there are fewer users than sample people). No users → empty cells.
 */
export function presetPeopleMap(users: OcUser[]): Map<string, string | null> {
  const known = new Set(users.map((u) => u.id));
  const demoIds = new Set(DEMO_PEOPLE.map((d) => d.id));
  const free = users.filter((u) => !demoIds.has(u.id));
  const pool = free.length ? free : users;
  const out = new Map<string, string | null>();
  let i = 0;
  for (const d of DEMO_PEOPLE) out.set(d.id, known.has(d.id) ? d.id : pool.length ? pool[i++ % pool.length].id : null);
  return out;
}

/**
 * Create a database from a preset (default `blank`). Returns the new dbId.
 * Pass `users` (the host's people) so sample rows are assigned to real people instead of
 * the built-in sample names; see `presetPeopleMap`.
 */
export function createDatabase(doc: Y.Doc, preset: DbPreset = "blank", users?: OcUser[]): string {
  const p = PRESETS[preset] ?? PRESETS.blank;
  const fields = p.fields.map((f) => ({ ...f, options: f.options?.map((o) => ({ ...o })) }));
  const people = users ? presetPeopleMap(users) : null;
  const rows = p.rows.map((r) => {
    const v: Record<string, CellValue> = {};
    fields.forEach((f, i) => (v[f.id] = r[i] === undefined || r[i] === "" ? (f.type === "title" ? "" : emptyValue(f.type)) : r[i]));
    if (people) for (const f of fields) if (f.type === "person" && typeof v[f.id] === "string" && people.has(v[f.id] as string)) v[f.id] = people.get(v[f.id] as string)!;
    return v;
  });
  return writeDb(doc, { name: p.name, icon: p.icon, tone: p.tone, view: p.view, fields, rows });
}

/** Import CSV text as a new database. Returns the new dbId. Pass `users` to detect person columns. */
export function importCsvToDatabase(doc: Y.Doc, csv: string, name?: string, opts: { users?: OcUser[] } = {}): string {
  const parsed = parseCsv(csv);
  const users = opts.users ?? [];
  if (!parsed.length) parsed.push(["Name"]);
  const fields = detectFields(parsed, users);
  const rows = parsed.slice(1).map((r) => {
    const v: Record<string, CellValue> = {};
    fields.forEach((f, i) => (v[f.id] = f.type === "title" ? (r[i] ?? "").trim() : coerce(r[i] ?? "", f.type, users)));
    return v;
  });
  return writeDb(doc, { name: name?.trim() || "Imported data", icon: "file-spreadsheet", tone: "green", fields, rows });
}

/* ------------------------------------------------------------------ read */

function readFields(m: Y.Map<unknown>): DbField[] {
  const arr = m.get("fields");
  if (!(arr instanceof Y.Array)) return [];
  const out: DbField[] = [];
  const seen = new Set<string>();
  for (const f of arr.toArray() as unknown[]) {
    if (!(f instanceof Y.Map)) continue;
    const id = String(f.get("id") ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const opts = f.get("options");
    let options: DbOption[] | undefined;
    if (Array.isArray(opts)) options = opts.filter((o) => o && typeof o.v === "string").map((o) => ({ v: o.v, c: (o.c ?? "gray") as Tone }));
    else if (typeof opts === "string") {
      try {
        const j = JSON.parse(opts);
        if (Array.isArray(j)) options = j;
      } catch {
        /* ignore malformed */
      }
    }
    out.push({ id, name: String(f.get("name") ?? ""), type: (f.get("type") as FieldType) ?? "text", options });
  }
  return out;
}

export function readDb(id: string, m: Y.Map<unknown>): DbSnapshot {
  const fields = readFields(m);
  const rowsMap = m.get("rows");
  const orderArr = m.get("order");
  const notesMap = m.get("notes");
  const viewsMap = m.get("views");
  const rows: DbRow[] = [];
  const seen = new Set<string>();
  const pushRow = (rid: string) => {
    if (seen.has(rid) || !(rowsMap instanceof Y.Map)) return;
    const r = rowsMap.get(rid);
    if (!(r instanceof Y.Map)) return;
    seen.add(rid);
    rows.push({ id: rid, v: r.toJSON() as Record<string, CellValue> });
  };
  if (orderArr instanceof Y.Array) for (const rid of orderArr.toArray()) pushRow(String(rid));
  if (rowsMap instanceof Y.Map) [...rowsMap.keys()].sort().forEach(pushRow);
  const views: Record<string, ViewPrefs> = {};
  if (viewsMap instanceof Y.Map) viewsMap.forEach((v, k) => (views[k] = typeof v === "string" ? safeJson(v) : ((v as ViewPrefs) ?? {})));
  const view = m.get("view") as ViewKind;
  return {
    id,
    name: String(m.get("name") ?? ""),
    icon: String(m.get("icon") ?? "database"),
    tone: (m.get("tone") as Tone) ?? "gray",
    fields,
    rows,
    notes: notesMap instanceof Y.Map ? (notesMap.toJSON() as Record<string, string>) : {},
    view: VIEW_KINDS.includes(view) ? view : "table",
    views,
  };
}

function safeJson(s: string): ViewPrefs {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------- mutations */

function ensure<T>(m: Y.Map<unknown>, key: string, make: () => T): T {
  const cur = m.get(key);
  if (cur instanceof Y.AbstractType) return cur as T;
  const n = make();
  m.set(key, n);
  return n;
}
const rowsOf = (m: Y.Map<unknown>) => ensure(m, "rows", () => new Y.Map<Y.Map<unknown>>()) as Y.Map<Y.Map<unknown>>;
const orderOf = (m: Y.Map<unknown>) => ensure(m, "order", () => new Y.Array<string>()) as Y.Array<string>;
const fieldsOf = (m: Y.Map<unknown>) => ensure(m, "fields", () => new Y.Array<Y.Map<unknown>>()) as Y.Array<Y.Map<unknown>>;
const notesOf = (m: Y.Map<unknown>) => ensure(m, "notes", () => new Y.Map<string>()) as Y.Map<string>;
const viewsOf = (m: Y.Map<unknown>) => ensure(m, "views", () => new Y.Map<unknown>()) as Y.Map<unknown>;

function tx(doc: Y.Doc, dbId: string, fn: (m: Y.Map<unknown>) => void) {
  const m = getDbMap(doc, dbId);
  if (!m) return;
  doc.transact(() => fn(m), DB_ORIGIN);
}

function fieldY(m: Y.Map<unknown>, fid: string): Y.Map<unknown> | undefined {
  return fieldsOf(m)
    .toArray()
    .find((f) => f instanceof Y.Map && f.get("id") === fid);
}

export function setDbMeta(doc: Y.Doc, dbId: string, patch: { name?: string; icon?: string; tone?: Tone }) {
  tx(doc, dbId, (m) => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) m.set(k, v);
  });
}

export function setView(doc: Y.Doc, dbId: string, view: ViewKind) {
  tx(doc, dbId, (m) => m.set("view", view));
}

export function setPrefs(doc: Y.Doc, dbId: string, view: ViewKind, patch: Partial<ViewPrefs>) {
  tx(doc, dbId, (m) => {
    const vm = viewsOf(m);
    const cur = vm.get(view);
    const base: ViewPrefs = typeof cur === "string" ? safeJson(cur) : ((cur as ViewPrefs) ?? {});
    vm.set(view, { ...base, ...patch });
  });
}

export function setCell(doc: Y.Doc, dbId: string, rowId: string, fid: string, value: CellValue) {
  tx(doc, dbId, (m) => {
    const r = rowsOf(m).get(rowId);
    if (r instanceof Y.Map) r.set(fid, Array.isArray(value) ? value.slice() : value);
  });
}

export function setNote(doc: Y.Doc, dbId: string, rowId: string, text: string) {
  tx(doc, dbId, (m) => {
    const n = notesOf(m);
    if (text) n.set(rowId, text);
    else n.delete(rowId);
  });
}

/** Add a row (appended, or after `afterId`). Returns the new row id. */
export function addRow(doc: Y.Doc, dbId: string, values: Record<string, CellValue> = {}, afterId?: string): string {
  const rid = nid("r");
  tx(doc, dbId, (m) => {
    const fields = readFields(m);
    const v: Record<string, CellValue> = {};
    for (const f of fields) v[f.id] = f.id in values ? values[f.id] : f.type === "title" ? "" : emptyValue(f.type);
    rowsOf(m).set(rid, rowToY(fields, v));
    const order = orderOf(m);
    const at = afterId ? order.toArray().indexOf(afterId) : -1;
    if (at >= 0) order.insert(at + 1, [rid]);
    else order.push([rid]);
  });
  return rid;
}

export interface RowBackup {
  id: string;
  index: number;
  v: Record<string, CellValue>;
  note?: string;
}

export function deleteRow(doc: Y.Doc, dbId: string, rowId: string): RowBackup | null {
  let backup: RowBackup | null = null;
  tx(doc, dbId, (m) => {
    const rows = rowsOf(m);
    const r = rows.get(rowId);
    const order = orderOf(m);
    const index = order.toArray().indexOf(rowId);
    backup = { id: rowId, index, v: r instanceof Y.Map ? (r.toJSON() as Record<string, CellValue>) : {}, note: notesOf(m).get(rowId) };
    rows.delete(rowId);
    // Remove every occurrence (concurrent inserts could have duplicated it).
    const arr = order.toArray();
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === rowId) order.delete(i, 1);
    notesOf(m).delete(rowId);
  });
  return backup;
}

/**
 * Move a row in `order` to just before `beforeId` (or to the end when `beforeId` is null /
 * missing). Used by board-view reordering. Duplicates left by concurrent moves are removed.
 */
export function moveRow(doc: Y.Doc, dbId: string, rowId: string, beforeId: string | null) {
  if (rowId === beforeId) return;
  tx(doc, dbId, (m) => {
    if (!rowsOf(m).has(rowId)) return;
    const order = orderOf(m);
    let arr = order.toArray();
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === rowId) order.delete(i, 1);
    arr = order.toArray();
    const at = beforeId ? arr.indexOf(beforeId) : -1;
    order.insert(at >= 0 ? at : arr.length, [rowId]);
  });
}

export function restoreRow(doc: Y.Doc, dbId: string, b: RowBackup) {
  tx(doc, dbId, (m) => {
    const fields = readFields(m);
    const r = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(b.v)) r.set(k, v);
    for (const f of fields) if (!r.has(f.id)) r.set(f.id, emptyValue(f.type));
    rowsOf(m).set(b.id, r);
    const order = orderOf(m);
    order.insert(Math.max(0, Math.min(b.index, order.length)), [b.id]);
    if (b.note) notesOf(m).set(b.id, b.note);
  });
}

export const FIELD_LABEL: Record<FieldType, string> = {
  title: "Title", text: "Text", status: "Status", select: "Select", tags: "Tags", person: "Person",
  date: "Date", number: "Number", checkbox: "Checkbox", url: "URL", progress: "Progress",
};

export function defaultOptions(t: FieldType): DbOption[] | undefined {
  if (t === "status") return [{ v: "Not started", c: "gray" }, { v: "In progress", c: "blue" }, { v: "Done", c: "green" }];
  if (t === "select" || t === "tags") return [{ v: "Option A", c: "blue" }, { v: "Option B", c: "purple" }, { v: "Option C", c: "amber" }];
  return undefined;
}

export function addField(doc: Y.Doc, dbId: string, type: FieldType, name?: string): string {
  const fid = nid("f");
  tx(doc, dbId, (m) => {
    fieldsOf(m).push([fieldToY({ id: fid, name: name ?? FIELD_LABEL[type], type, options: defaultOptions(type) })]);
    rowsOf(m).forEach((r) => r instanceof Y.Map && r.set(fid, emptyValue(type)));
  });
  return fid;
}

export function renameField(doc: Y.Doc, dbId: string, fid: string, name: string) {
  tx(doc, dbId, (m) => fieldY(m, fid)?.set("name", name));
}

export function addOption(doc: Y.Doc, dbId: string, fid: string, v: string): DbOption | null {
  let made: DbOption | null = null;
  tx(doc, dbId, (m) => {
    const f = fieldY(m, fid);
    if (!f) return;
    const cur = (readFields(m).find((x) => x.id === fid)?.options ?? []).slice();
    if (cur.some((o) => o.v === v)) return;
    made = { v, c: toneFor(v, cur.length) };
    f.set("options", [...cur, made]);
  });
  return made;
}

export interface FieldBackup {
  index: number;
  field: DbField;
  values: Record<string, CellValue>;
}

export function deleteField(doc: Y.Doc, dbId: string, fid: string): FieldBackup | null {
  let backup: FieldBackup | null = null;
  tx(doc, dbId, (m) => {
    const arr = fieldsOf(m);
    const list = arr.toArray();
    const index = list.findIndex((f) => f instanceof Y.Map && f.get("id") === fid);
    if (index < 0) return;
    const field = readFields(m).find((f) => f.id === fid)!;
    if (field.type === "title") return;
    const values: Record<string, CellValue> = {};
    rowsOf(m).forEach((r, rid) => {
      if (r instanceof Y.Map) {
        values[rid] = r.get(fid) as CellValue;
        r.delete(fid);
      }
    });
    arr.delete(index, 1);
    backup = { index, field, values };
  });
  return backup;
}

export function restoreField(doc: Y.Doc, dbId: string, b: FieldBackup) {
  tx(doc, dbId, (m) => {
    const arr = fieldsOf(m);
    arr.insert(Math.min(b.index, arr.length), [fieldToY(b.field)]);
    rowsOf(m).forEach((r, rid) => r instanceof Y.Map && r.set(b.field.id, rid in b.values ? b.values[rid] : emptyValue(b.field.type)));
  });
}

/**
 * Append CSV rows to an existing database. Columns match fields by name (case-insensitive);
 * unknown columns become new fields with a detected type. Returns the number of rows added.
 */
export function appendCsv(doc: Y.Doc, dbId: string, csv: string, users: OcUser[] = []): number {
  const parsed = parseCsv(csv);
  if (parsed.length < 2) return 0;
  const detected = detectFields(parsed, users);
  let added = 0;
  tx(doc, dbId, (m) => {
    const fields = readFields(m);
    const map: (DbField | null)[] = detected.map((d, i) => {
      const hit = fields.find((f) => f.name.trim().toLowerCase() === d.name.toLowerCase()) ?? (i === 0 ? fields.find((f) => f.type === "title") : undefined);
      if (hit) return hit;
      const nf: DbField = { ...d, id: nid("f"), type: d.type === "title" ? "text" : d.type };
      fieldsOf(m).push([fieldToY(nf)]);
      rowsOf(m).forEach((r) => r instanceof Y.Map && r.set(nf.id, emptyValue(nf.type)));
      fields.push(nf);
      return nf;
    });
    const ids: string[] = [];
    for (const r of parsed.slice(1)) {
      const v: Record<string, CellValue> = {};
      map.forEach((f, i) => {
        if (!f) return;
        let x = f.type === "title" ? (r[i] ?? "").trim() : coerce(r[i] ?? "", f.type, users);
        // Unknown option values are added to the field so nothing is lost.
        if ((f.type === "status" || f.type === "select") && typeof x === "string" && x && !f.options?.some((o) => o.v === x)) {
          f.options = [...(f.options ?? []), { v: x, c: toneFor(x, f.options?.length ?? 0) }];
          fieldY(m, f.id)?.set("options", f.options);
        }
        if (f.type === "tags" && Array.isArray(x)) {
          const missing = x.filter((t) => !f.options?.some((o) => o.v === t));
          if (missing.length) {
            f.options = [...(f.options ?? []), ...missing.map((t, j) => ({ v: t, c: toneFor(t, (f.options?.length ?? 0) + j) }))];
            fieldY(m, f.id)?.set("options", f.options);
          }
        }
        v[f.id] = x;
      });
      const rid = nid("r");
      for (const f of fields) if (!(f.id in v)) v[f.id] = f.type === "title" ? "" : emptyValue(f.type);
      rowsOf(m).set(rid, rowToY(fields, v));
      ids.push(rid);
    }
    orderOf(m).push(ids);
    added = ids.length;
  });
  return added;
}

/* ---------------------------------------------------------------- export */

export function personName(id: unknown, users: OcUser[] = []): string {
  if (!id) return "";
  const s = String(id);
  return (users.find((u) => u.id === s) ?? DEMO_PEOPLE.find((u) => u.id === s))?.name ?? s;
}

export function cellToText(f: DbField, v: CellValue | undefined, users: OcUser[] = []): string {
  if (v == null) return "";
  switch (f.type) {
    case "person":
      return personName(v, users);
    case "tags":
      return Array.isArray(v) ? v.join("; ") : String(v);
    case "checkbox":
      return v ? "true" : "false";
    case "progress":
      return v === "" ? "" : `${v}%`;
    default:
      return String(v);
  }
}

/** Export a database (all rows, in `order`) as CSV. Person cells are written as names. */
export function databaseToCsv(doc: Y.Doc, dbId: string, users: OcUser[] = []): string {
  const m = getDbMap(doc, dbId);
  if (!m) return "";
  const db = readDb(dbId, m);
  return toCsv([db.fields.map((f) => f.name), ...db.rows.map((r) => db.fields.map((f) => cellToText(f, r.v[f.id], users)))]);
}

export function databaseToMarkdown(db: DbSnapshot, users: OcUser[] = []): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = "| " + db.fields.map((f) => esc(f.name)).join(" | ") + " |";
  const sep = "| " + db.fields.map(() => "---").join(" | ") + " |";
  const body = db.rows.map((r) => "| " + db.fields.map((f) => esc(cellToText(f, r.v[f.id], users))).join(" | ") + " |");
  return [head, sep, ...body].join("\n");
}
