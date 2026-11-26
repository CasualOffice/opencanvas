// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Relation and rollup setup, and the related-rows picker (prototype 2a, 2b, 3a, 5b).

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { Check, Plus, Radio } from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import { addRow, databasesRoot, readDb } from "../model";
import { titleField } from "../query";
import type { DbField, DbSnapshot, RollDef, RollFn } from "../types";
import { Ic } from "../ui";
import { computedValue } from "./cells";
import type { Engine } from "./engine";
import type { Related } from "./hooks";

const dbsOf = (doc: Y.Doc) =>
  [...databasesRoot(doc).entries()].filter(([, m]) => m instanceof Y.Map).map(([id, m]) => readDb(id, m as Y.Map<unknown>));

const rowsWord = (n: number) => `${n.toLocaleString("en-US")} row${n === 1 ? "" : "s"}`;

export function RelationSetup({ doc, db, f, env, onAdd, onCancel }: {
  doc: Y.Doc;
  db: DbSnapshot;
  f: DbField;
  env: BlockEnv;
  onAdd: (p: { name: string; target: { db: string; file?: string }; two: boolean }) => void;
  onCancel: () => void;
}) {
  const local = useMemo(() => dbsOf(doc).filter((d) => d.id !== db.id), [doc, db.id]);
  const live = env.liveDbs?.() ?? [];
  const [name, setName] = useState(f.name === "Relation" || !f.name ? "" : f.name);
  const [target, setTarget] = useState<{ db: string; file?: string } | null>(local[0] ? { db: local[0].id } : null);
  const [two, setTwo] = useState(true);
  const isLive = !!target?.file;
  const tName = target ? (isLive ? live.find((l) => l.dbId === target.db && l.fileId === target.file)?.name : local.find((d) => d.id === target.db)?.name) : "";
  return (
    <div className="ocdb-setup" role="group" aria-label="New relation field">
      <div className="ocdb-fx-h">New relation field</div>
      <p className="note">Link each {db.name ? `row of ${db.name}` : "row"} to rows in another database.</p>
      <label>
        Field name
        <input className="ocdb-pin" value={name} placeholder={tName || "Related"} onChange={(e) => setName(e.target.value)} />
      </label>
      <div role="radiogroup" aria-label="Related database" className="dbs">
        <div className="grp">On this canvas</div>
        {local.length ? local.map((d) => (
          <button key={d.id} type="button" role="radio" aria-checked={target?.db === d.id && !target.file} onClick={() => setTarget({ db: d.id })}>
            {d.name || "Untitled"}<span className="sub">{rowsWord(d.rows.length)}</span>
          </button>
        )) : <p className="note">No other database on this canvas yet.</p>}
        <div className="grp">Live blocks from other canvases</div>
        {live.length ? live.map((l) => (
          <button key={l.fileId + l.dbId} type="button" role="radio" aria-checked={target?.db === l.dbId && target.file === l.fileId} onClick={() => (setTarget({ db: l.dbId, file: l.fileId }), setTwo(false))}>
            <Ic i={Radio} s={13} />{l.name}<span className="sub">{l.source}</span>
          </button>
        )) : <p className="note">To link a database in another canvas, add a live block of it to this canvas first.</p>}
      </div>
      <div className="seg" role="radiogroup" aria-label="Direction">
        <button type="button" role="radio" aria-checked={!two} onClick={() => setTwo(false)}>One-way</button>
        <button type="button" role="radio" aria-checked={two} disabled={isLive} onClick={() => setTwo(true)}>Two-way</button>
      </div>
      <p className="note">
        {isLive ? "Across canvases links are one-way: the other canvas is never changed, and readers without access see “No access”." : two ? `Adds ${db.name || "this database"} to ${tName || "the target"}. Editing either side updates both.` : `Only ${db.name || "this database"} shows the link.`}
      </p>
      <div className="ocdb-fx-ft">
        <button type="button" className="ocdb-btn sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="ocdb-btn sm primary" disabled={!target} onClick={() => target && onAdd({ name: name.trim() || tName || "Related", target, two: two && !isLive })}>Add field</button>
      </div>
    </div>
  );
}

/** Pick related rows: a search list, linked rows on top with a check; clicking toggles. */
export function RelationPicker({ doc, f, value, rowTitle, onChange, onDone, edit }: {
  doc: Y.Doc;
  f: DbField;
  value: string[];
  rowTitle: string;
  onChange: (ids: string[]) => void;
  onDone: () => void;
  edit: boolean;
}) {
  const [q, setQ] = useState("");
  const inp = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => inp.current?.focus({ preventScroll: true }), []);
  const m = f.rel && !f.rel.file ? databasesRoot(doc).get(f.rel.db) : null;
  const target = m instanceof Y.Map ? readDb(f.rel!.db, m) : null;
  if (!target) {
    return <div className="ocdb-rp"><p className="ocdb-hint" style={{ padding: ".75rem" }}>{f.rel?.file ? "Rows of another canvas are picked in its live block." : "The linked database was deleted. Links are kept for 30 days."}</p></div>;
  }
  const tf = titleField(target);
  const sub = target.fields.find((x) => x.id !== tf?.id && (x.type === "date" || x.type === "status" || x.type === "select"));
  const t = (r: { v: Record<string, unknown> }) => String(r.v[tf?.id ?? ""] ?? "") || "Untitled";
  const ql = q.trim().toLowerCase();
  const list = target.rows.filter((r) => !ql || t(r).toLowerCase().includes(ql));
  list.sort((a, b) => Number(value.includes(b.id)) - Number(value.includes(a.id)));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="ocdb-rp" role="group" aria-label={`${f.name} for “${rowTitle}”`}>
      <div className="ocdb-pad">
        <input ref={inp} className="ocdb-pin" placeholder={`Search ${target.name.toLowerCase() || "rows"}`} aria-label="Search rows" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} />
      </div>
      <ul aria-label={target.name}>
        {list.slice(0, 200).map((r) => (
          <li key={r.id}>
            <button type="button" role="checkbox" aria-checked={value.includes(r.id)} disabled={!edit} onClick={() => toggle(r.id)}>
              <span className="ck">{value.includes(r.id) ? <Ic i={Check} s={14} /> : null}</span>
              {t(r)}
              {sub ? <span className="sub">{String(r.v[sub.id] ?? "")}</span> : null}
            </button>
          </li>
        ))}
        {edit && ql && !list.some((r) => t(r).toLowerCase() === ql) ? (
          <li>
            <button type="button" onClick={() => {
              const id = addRow(doc, target.id, tf ? { [tf.id]: q.trim() } : {});
              onChange([...value, id]);
              setQ("");
            }}>
              <span className="ck"><Ic i={Plus} s={14} /></span>New {target.name ? target.name.replace(/s$/, "").toLowerCase() : "row"} “{q.trim()}”
            </button>
          </li>
        ) : null}
      </ul>
      <div className="ocdb-fx-ft" style={{ padding: ".5rem .75rem" }}>
        <button type="button" className="ocdb-btn sm primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

const FN_LABEL: Record<RollFn, string> = { count: "Count all", sum: "Sum", percent: "Percent checked", earliest: "Earliest", latest: "Latest" };

/** The calculations that fit a field type (prototype 3a). */
export function fnsFor(t: DbField | undefined): RollFn[] {
  if (!t) return ["count"];
  if (t.type === "checkbox") return ["count", "percent"];
  if (t.type === "date") return ["count", "earliest", "latest"];
  if (t.type === "number" || t.type === "progress" || t.type === "formula") return ["count", "sum"];
  return ["count"];
}

export function RollupSetup({ doc, db, f, engine, related, onSave, onCancel }: {
  doc: Y.Doc;
  db: DbSnapshot;
  f: DbField;
  engine: Engine | null;
  related: Related;
  onSave: (r: RollDef) => void;
  onCancel: () => void;
}) {
  const rels = db.fields.filter((x) => x.type === "relation");
  const [rel, setRel] = useState(f.roll?.rel ?? rels[0]?.id ?? "");
  const relF = rels.find((x) => x.id === rel);
  const m = relF?.rel && !relF.rel.file ? databasesRoot(doc).get(relF.rel.db) : null;
  const target = m instanceof Y.Map ? readDb(relF!.rel!.db, m) : null;
  const tfields = target?.fields ?? [];
  const [fid, setFid] = useState(f.roll?.f ?? tfields.find((x) => x.type === "checkbox")?.id ?? tfields[0]?.id ?? "");
  const tf = tfields.find((x) => x.id === fid);
  const fns = fnsFor(tf);
  const [fn, setFn] = useState<RollFn>(f.roll?.fn && fns.includes(f.roll.fn) ? f.roll.fn : fns[fns.length - 1]);
  const roll: RollDef = { rel, f: fid || undefined, fn: fns.includes(fn) ? fn : "count" };
  const first = db.rows[0];
  const preview = useMemo(() => {
    if (!engine || !first || !rel) return undefined;
    const fields = db.fields.map((x) => (x.id === f.id ? { ...x, type: "rollup" as const, roll } : x));
    try {
      return engine.compute({ fields, rows: [first], related }).rows[first.id]?.[f.id];
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, first, rel, fid, fn, related]);
  const tt = titleField(db);
  return (
    <div className="ocdb-setup" role="group" aria-label={`${f.name}: rollup`}>
      <div className="ocdb-fx-h">{f.name} · Rollup</div>
      {rels.length ? (
        <div className="row3">
          <label>Relation
            <select value={rel} onChange={(e) => setRel(e.target.value)}>{rels.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
          <label>Field
            <select value={fid} onChange={(e) => setFid(e.target.value)} disabled={!tfields.length}>{tfields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
          <label>Calculate
            <select value={roll.fn} onChange={(e) => setFn(e.target.value as RollFn)}>{fns.map((x) => <option key={x} value={x}>{FN_LABEL[x]}</option>)}</select>
          </label>
        </div>
      ) : <p className="note">A rollup reads a relation. Add a relation field first.</p>}
      {first && rels.length ? <p className="note">{String(first.v[tt?.id ?? ""] ?? "") || "First row"}: {computedValue({ ...f, roll }, preview)}</p> : null}
      <div className="ocdb-fx-ft">
        <button type="button" className="ocdb-btn sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="ocdb-btn sm primary" disabled={!rel} onClick={() => onSave(roll)}>Save</button>
      </div>
    </div>
  );
}
