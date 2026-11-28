// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Properties panel, something selected (DGM-14 S4, prototype 4a-4d). Lives in the lazy diagram
// chunk. Every input writes one key (a shape key or one `props` key, merged per field, ADR-045).
// View-only people get the same sections read only (10c).
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Y from "yjs";
import { Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import type { Shape } from "../../model";
import {
  ARROWS, CARDINALITY, MIXED, NETWORK_KINDS, VIS, VIS_NAME, libraryOf, listOf, moveItem, moveTo, nameOf, panelOf, propOf, relation,
  setField, setProp, shared, touchesErd, type Column, type KeyMark, type Member, type Shared, type Vis,
} from "./fields";
import { ensurePropsStyles } from "./styles";
import { PlaceholderPanel, unknownOf } from "../Placeholder";
import { OrphanNotice } from "../Presence";
// BRD-22 decision 4: the board's style panel, the same component, inside Properties.
import StylePanel from "../../style/StylePanel";
import { applyStyle, rememberLast, styled } from "../../style/style";

const SW = 1.75;

export interface PropertiesProps {
  doc: Y.Doc;
  boardId: string;
  /** The selected shapes (at least one). */
  selected: Shape[];
  /** Every shape of the board (connections, ends). */
  shapes: Shape[];
  edit: boolean;
  origin?: unknown;
  /** Extra content under the header (presence notice, placeholders' explanation). */
  notice?: ReactNode;
}

const MIX = "Mixed";
const show = <T,>(v: Shared<T>): string => (v === MIXED ? "" : v == null ? "" : String(v));

/** A text input that writes on blur or Enter; Esc restores. Shows "Mixed" as its placeholder. */
function Text({ label, value, edit, onCommit, placeholder, mono }: { label: string; value: Shared<string>; edit: boolean; onCommit: (v: string) => void; placeholder?: string; mono?: boolean }) {
  const cur = show(value);
  const [v, setV] = useState(cur);
  useEffect(() => setV(cur), [cur]);
  return (
    <label className="ocdg-fld ocpp-fld">
      <span className="ocdg-lbl">{label}</span>
      <input
        className={"ocdg-inp" + (mono ? " ocpp-mono" : "")}
        value={v}
        readOnly={!edit}
        placeholder={value === MIXED ? MIX : placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== cur && !(value === MIXED && v === "") && onCommit(v)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            setV(cur);
          }
        }}
      />
    </label>
  );
}

/** Multi-line text (shape text): Enter adds a line; ⌘/Ctrl+Enter or blur writes; Esc restores. */
function Area({ label, value, edit, onCommit }: { label: string; value: Shared<string>; edit: boolean; onCommit: (v: string) => void }) {
  const cur = show(value);
  const [v, setV] = useState(cur);
  useEffect(() => setV(cur), [cur]);
  const rows = Math.min(6, Math.max(2, v.split("\n").length));
  return (
    <label className="ocdg-fld ocpp-fld">
      <span className="ocdg-lbl">{label}</span>
      <textarea
        className="ocdg-inp ocpp-ta"
        value={v}
        rows={rows}
        readOnly={!edit}
        placeholder={value === MIXED ? MIX : undefined}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== cur && !(value === MIXED && v === "") && onCommit(v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            setV(cur);
          }
        }}
      />
    </label>
  );
}

/** The colours a shape can take (prototype 4c): the 7 tones, or the 4 sticky colours for stickies. */
const TONE_SW: [string, string][] = [["gray", "Gray"], ["blue", "Blue"], ["green", "Green"], ["amber", "Amber"], ["purple", "Purple"], ["pink", "Pink"], ["red", "Red"]];
const STICKY_SW: [string, string][] = [["y", "Yellow"], ["p", "Pink"], ["b", "Blue"], ["g", "Green"]];
function Swatches({ sel, edit, onChange }: { sel: Shape[]; edit: boolean; onChange: (fill: string) => void }) {
  const sticky = sel.every((s) => s.type === "sticky");
  const value = shared(sel, (s) => s.fill ?? (s.type === "sticky" ? "y" : ""));
  return (
    <div className="ocdg-fld ocpp-fld">
      <span className="ocdg-lbl" aria-hidden="true">Colour</span>
      <div className="ocpp-sws" role="radiogroup" aria-label="Colour">
        {(sticky ? STICKY_SW : TONE_SW).map(([c, name]) => (
          <button
            key={c}
            type="button"
            role="radio"
            className="ocpp-sw"
            aria-label={name}
            title={name}
            aria-checked={value === c}
            disabled={!edit}
            style={{ background: sticky ? `var(--sticky-${c})` : `var(--${c}-bg)`, boxShadow: (sticky ? "inset 0 0 0 1px var(--line-2)" : `inset 0 0 0 1.5px var(--${c}-fg)`) + (value === c ? ", 0 0 0 2px var(--app), 0 0 0 3.5px var(--accent)" : "") }}
            onClick={() => onChange(c)}
          />
        ))}
        {value === MIXED ? <span className="ocpp-mxl">{MIX}</span> : null}
      </div>
    </div>
  );
}

function Select({ label, value, options, edit, onChange }: { label: string; value: Shared<string>; options: [string, string][]; edit: boolean; onChange: (v: string) => void }) {
  return (
    <label className="ocdg-fld ocpp-fld">
      <span className="ocdg-lbl">{label}</span>
      <select className="ocdg-inp" value={value === MIXED ? "" : (value ?? options[0]![0])} disabled={!edit} onChange={(e) => onChange(e.target.value)}>
        {value === MIXED ? <option value="">{MIX}</option> : null}
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function Check({ label, hint, value, edit, onChange }: { label: string; hint?: string; value: Shared<boolean>; edit: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={value === MIXED ? "mixed" : !!value} className="ocdg-sw" disabled={!edit} onClick={() => onChange(value !== true)}>
      <span className="ocdg-swt">
        {label}
        {hint ? <span className="ocdg-hint">{value === MIXED ? MIX : hint}</span> : null}
      </span>
      <span className="ocdg-tgl" aria-hidden="true" />
    </button>
  );
}

function Sec({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const id = "ocpp-" + title.toLowerCase().replace(/\W+/g, "-");
  return (
    <section className="ocdg-sec" aria-labelledby={id}>
      <h3 className="ocdg-sh" id={id}>
        {title}
        {count != null ? <span className="ocpp-count">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/**
 * A reorderable list of rows (attributes, methods, columns): drag the grip, or ⌥↑ / ⌥↓ on a row.
 * The whole list is one `props` key.
 */
function Rows<T extends object>({ label, items, edit, onChange, render, blank }: { label: string; items: T[]; edit: boolean; onChange: (next: T[]) => void; render: (it: T, set: (patch: Partial<T>) => void) => ReactNode; blank: T }) {
  const [drag, setDrag] = useState<number | null>(null);
  const key = (e: KeyboardEvent, i: number) => {
    if (!edit || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const next = moveItem(items, i, e.key === "ArrowUp" ? -1 : 1);
    if (next !== items) {
      onChange(next);
      const row = e.currentTarget as HTMLElement;
      requestAnimationFrame(() => (row.parentElement?.children[i + (e.key === "ArrowUp" ? -1 : 1)] as HTMLElement | undefined)?.focus());
    }
  };
  return (
    <>
      <ul className="ocpp-rows" aria-label={label}>
        {items.map((it, i) => (
          <li
            key={i}
            className="ocpp-row"
            tabIndex={-1}
            aria-label={`${label} ${i + 1} of ${items.length}`}
            onKeyDown={(e) => key(e, i)}
            onDragOver={(e) => drag !== null && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (drag !== null) onChange(moveTo(items, drag, i));
              setDrag(null);
            }}
          >
            {edit ? (
              <span className="ocpp-grip" draggable onDragStart={(e) => (setDrag(i), e.dataTransfer?.setData("text/plain", String(i)))} onDragEnd={() => setDrag(null)} title="Drag to reorder (⌥↑ / ⌥↓)" aria-hidden="true">
                <GripVertical size={14} strokeWidth={SW} />
              </span>
            ) : null}
            {render(it, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}
            {edit ? (
              <button type="button" className="ocdg-ib ocpp-del" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                <Trash2 size={14} strokeWidth={SW} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {edit ? (
        <button type="button" className="ocpp-add" onClick={() => onChange([...items, { ...blank }])}>
          <Plus size={14} strokeWidth={SW} />
          Add {label.toLowerCase().replace(/s$/, "")}
        </button>
      ) : null}
    </>
  );
}

/** A small cell input inside a row (commit on blur / Enter). */
function Cell({ value, label, edit, onCommit, wide }: { value: string; label: string; edit: boolean; onCommit: (v: string) => void; wide?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={"ocpp-cell" + (wide ? " w" : "")}
      aria-label={label}
      value={v}
      readOnly={!edit}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

export function Properties(p: PropertiesProps) {
  ensurePropsStyles();
  const { doc, boardId, selected, shapes, edit, origin } = p;
  const ids = selected.map((s) => s.id);
  const byId = (id: string) => shapes.find((s) => s.id === id);
  const prop = (k: string, v: unknown) => setProp(doc, boardId, ids, k, v, origin);
  const field = (patch: Partial<Shape>) => setField(doc, boardId, ids, patch, origin);
  const one = selected.length === 1 ? selected[0]! : null;
  const kind = shared(selected, (s) => s.kind);
  const panel = shared(selected, panelOf);
  const lib = typeof kind === "string" ? libraryOf(kind) : undefined;
  const heading = panel === "connector" ? (touchesErd(selected[0]!, byId) ? "Relationship" : "Connector") : panel === "uml-class" ? "Class" : panel === "erd-entity" ? "Entity" : panel === "network" ? (NETWORK_KINDS.find(([k]) => k === kind)?.[1] ?? "Node") : "Shape";
  const title = one ? (one.type === "arrow" ? (one.text ? `“${one.text}”` : `${nameOf(byId(one.start?.shapeId ?? ""))} → ${nameOf(byId(one.end?.shapeId ?? ""))}`) : nameOf(one)) : `${selected.length} selected`;

  const unk = one ? unknownOf(one) : null;
  if (one && unk) {
    return (
      <div className="ocdg-panel ocpp" data-panel={unk.what === "type" ? "unknown-type" : "missing-library"}>
        <h2 className="ocdg-ph ocpp-h">
          <span className="ocpp-kind">{unk.what === "type" ? "Unknown shape" : "From a library you don’t have"}</span>
          <span className="ocpp-title">{nameOf(one)}</span>
        </h2>
        {p.notice}
        <PlaceholderPanel s={one} u={unk} />
        <Sec title="Text">
          <Text label="Name" value={one.text ?? ""} edit={edit} onCommit={(text) => field({ text })} />
        </Sec>
        <Sec title="Position and size">
          <div className="ocpp-xywh">
            {(["x", "y", "w", "h"] as const).map((k) => (
              <Text key={k} label={k.toUpperCase()} value={String(Math.round(one[k] ?? 0))} edit={edit} onCommit={(v) => Number.isFinite(Number(v)) && v.trim() !== "" && field({ [k]: k === "w" || k === "h" ? Math.max(8, Number(v)) : Number(v) })} />
            ))}
          </div>
        </Sec>
      </div>
    );
  }
  return (
    <div className="ocdg-panel ocpp" data-panel={panel === MIXED ? "mixed" : panel}>
      <h2 className="ocdg-ph ocpp-h">
        <span className="ocpp-kind">{panel === MIXED ? "Mixed selection" : heading}{lib && panel !== MIXED ? ` · ${lib}` : ""}</span>
        <span className="ocpp-title">{title}</span>
      </h2>
      {p.notice}
      {one?.type === "arrow" ? <OrphanNotice doc={doc} boardId={boardId} c={one} shapes={shapes} edit={edit} origin={origin} /> : null}
      {panel === "connector" ? <ConnectorProps {...p} prop={prop} field={field} byId={byId} /> : null}
      {panel === "uml-class" && one ? <UmlProps s={one} edit={edit} prop={prop} field={field} /> : null}
      {panel === "erd-entity" && one ? <ErdProps s={one} edit={edit} prop={prop} field={field} shapes={shapes} byId={byId} /> : null}
      {panel === "network" ? <NetworkProps sel={selected} edit={edit} prop={prop} field={field} shapes={shapes} byId={byId} /> : null}
      {panel === "shape" || panel === MIXED || ((panel === "uml-class" || panel === "erd-entity") && !one) ? <ShapeProps sel={selected} edit={edit} field={field} /> : null}
      {edit && selected.some(styled) ? (
        <Sec title="Style">
          <StylePanel
            embedded
            list={selected.filter(styled)}
            onSet={(k, v) => {
              applyStyle(doc, boardId, selected, k, v, origin);
              if (k !== "ah0" && k !== "ah1") rememberLast(k, v);
            }}
          />
        </Sec>
      ) : null}
      {!edit ? <CopyText sel={selected} /> : null}
    </div>
  );
}

/** View only (10c): copy the selection's text. */
function CopyText({ sel }: { sel: Shape[] }) {
  const [done, setDone] = useState(false);
  const text = sel.map((s) => s.text ?? "").filter(Boolean).join("\n");
  if (!text) return null;
  return (
    <section className="ocdg-sec">
      <button type="button" className="ocpp-copy" onClick={() => void navigator.clipboard?.writeText(text).then(() => setDone(true), () => {})}>
        <Copy size={14} strokeWidth={SW} aria-hidden="true" />
        {done ? "Copied" : "Copy text"}
      </button>
    </section>
  );
}

type Write = { prop: (k: string, v: unknown) => void; field: (patch: Partial<Shape>) => void };

function ShapeProps({ sel, edit, field }: { sel: Shape[]; edit: boolean } & Pick<Write, "field">) {
  const boxes = sel.filter((s) => s.type !== "arrow" && s.type !== "pen");
  return (
    <Sec title="Text">
      {sel.length === 1 ? <Area label="Text" value={sel[0]!.text ?? ""} edit={edit} onCommit={(text) => field({ text })} /> : null}
      {boxes.length ? <Text label="Text size" value={shared(boxes, (s) => (s.size ?? 14) + "")} edit={edit} onCommit={(v) => Number(v) > 0 && field({ size: Math.min(200, Number(v)) })} /> : null}
      <Swatches sel={sel} edit={edit} onChange={(fill) => field({ fill })} />
    </Sec>
  );
}

function UmlProps({ s, edit, prop, field }: { s: Shape; edit: boolean } & Write) {
  const attrs = listOf<Member>(propOf(s, "attributes"));
  const methods = listOf<Member>(propOf(s, "methods"));
  const member = (label: string) => (m: Member, set: (x: Partial<Member>) => void) => (
    <>
      <select className="ocpp-vis" aria-label={`${label} visibility`} value={m.vis ?? "-"} disabled={!edit} onChange={(e) => set({ vis: e.target.value as Vis })}>
        {VIS.map((v) => (
          <option key={v} value={v} title={VIS_NAME[v]}>{v}</option>
        ))}
      </select>
      <Cell label={`${label} name`} value={m.name ?? ""} edit={edit} onCommit={(name) => set({ name })} wide />
      <Cell label={`${label} type`} value={m.type ?? ""} edit={edit} onCommit={(type) => set({ type })} />
    </>
  );
  return (
    <>
      <Sec title="Class">
        <Text label="Name" value={s.text ?? ""} edit={edit} onCommit={(text) => field({ text })} />
        <Text label="Stereotype" value={propOf<string>(s, "stereotype") ?? ""} edit={edit} placeholder="None" onCommit={(v) => prop("stereotype", v.replace(/^«|»$/g, "").trim() || undefined)} />
        <Check label="Abstract" hint="Shows the name in italics" value={propOf<boolean>(s, "abstract") === true} edit={edit} onChange={(v) => prop("abstract", v || undefined)} />
      </Sec>
      <Sec title="Attributes" count={attrs.length}>
        <Rows label="Attributes" items={attrs} edit={edit} blank={{ vis: "-", name: "", type: "" }} onChange={(v) => prop("attributes", v)} render={member("Attribute")} />
      </Sec>
      <Sec title="Methods" count={methods.length}>
        <Rows label="Methods" items={methods} edit={edit} blank={{ vis: "+", name: "", type: "void" }} onChange={(v) => prop("methods", v)} render={member("Method")} />
      </Sec>
    </>
  );
}

const KEYS: KeyMark[] = ["", "pk", "fk"];
function ErdProps({ s, edit, prop, field, shapes, byId }: { s: Shape; edit: boolean; shapes: Shape[]; byId: (id: string) => Shape | undefined } & Write) {
  const cols = listOf<Column>(propOf(s, "columns"));
  const rels = shapes.filter((c) => c.type === "arrow" && (c.start?.shapeId === s.id || c.end?.shapeId === s.id));
  return (
    <>
      <Sec title="Entity">
        <Text label="Name" value={s.text ?? ""} edit={edit} onCommit={(text) => field({ text })} />
        <Text label="Note" value={propOf<string>(s, "note") ?? ""} edit={edit} onCommit={(v) => prop("note", v || undefined)} />
      </Sec>
      <Sec title="Columns" count={cols.length}>
        <Rows
          label="Columns"
          items={cols}
          edit={edit}
          blank={{ key: "", name: "", type: "text" }}
          onChange={(v) => prop("columns", v)}
          render={(c, set) => (
            <>
              <button type="button" className="ocpp-key" data-key={c.key || "none"} disabled={!edit} aria-label={`Key: ${c.key ? c.key.toUpperCase() : "none"}. Change`} onClick={() => set({ key: KEYS[(KEYS.indexOf(c.key ?? "") + 1) % 3]! })}>
                {c.key ? c.key.toUpperCase() : "–"}
              </button>
              <Cell label="Column name" value={c.name ?? ""} edit={edit} onCommit={(name) => set({ name })} wide />
              <Cell label="Column type" value={c.type ?? ""} edit={edit} onCommit={(type) => set({ type })} />
              <span className="ocpp-sub">
                {c.key === "fk" ? <Cell label="References" value={c.ref ?? ""} edit={edit} onCommit={(ref) => set({ ref: ref || undefined })} wide /> : null}
                <label className="ocpp-cb">
                  <input type="checkbox" checked={!!c.nullable} disabled={!edit || c.key === "pk"} onChange={(e) => set({ nullable: e.target.checked || undefined })} />
                  Can be empty
                </label>
              </span>
            </>
          )}
        />
      </Sec>
      <Sec title="Relationships" count={rels.length}>
        <ul className="ocpp-list">
          {rels.map((c) => (
            <li key={c.id}>
              <span>{nameOf(byId(c.start?.shapeId === s.id ? (c.end?.shapeId ?? "") : (c.start?.shapeId ?? ""))) || "Not connected"}</span>
              <span className="ocpp-dim">{relation(c, s.id)}</span>
            </li>
          ))}
        </ul>
      </Sec>
    </>
  );
}

function NetworkProps({ sel, edit, prop, field, shapes, byId }: { sel: Shape[]; edit: boolean; shapes: Shape[]; byId: (id: string) => Shape | undefined } & Write) {
  const one = sel.length === 1 ? sel[0]! : null;
  const conns = one ? shapes.filter((c) => c.type === "arrow" && (c.start?.shapeId === one.id || c.end?.shapeId === one.id)) : [];
  return (
    <>
      {one ? (
        <Sec title="Text">
          <Text label="Name" value={one.text ?? ""} edit={edit} onCommit={(text) => field({ text })} />
          <Text label="Detail" value={propOf<string>(one, "detail") ?? ""} edit={edit} onCommit={(v) => prop("detail", v || undefined)} />
        </Sec>
      ) : null}
      <Sec title="Shape">
        {/* Changing the kind writes `kind` only: name, colour and connections (bindings by id) stay (4c). */}
        <Select label="Kind" value={shared(sel, (s) => s.kind)} options={NETWORK_KINDS} edit={edit} onChange={(kind) => kind && field({ kind })} />
        <p className="ocdg-hint">Changing the kind keeps the name, colour and connections.</p>
        <Swatches sel={sel} edit={edit} onChange={(fill) => field({ fill })} />
      </Sec>
      {one ? (
        <Sec title="Connections" count={conns.length}>
          <ul className="ocpp-list">
            {conns.map((c) => {
              const out = c.start?.shapeId === one.id;
              return (
                <li key={c.id}>
                  <span>{nameOf(byId((out ? c.end?.shapeId : c.start?.shapeId) ?? "")) || "Not connected"}</span>
                  <span className="ocpp-dim">{out ? "out" : "in"}</span>
                </li>
              );
            })}
          </ul>
        </Sec>
      ) : null}
    </>
  );
}

function ConnectorProps({ selected, edit, prop, field, byId }: PropertiesProps & Write & { byId: (id: string) => Shape | undefined }) {
  const sel = selected;
  const one = sel.length === 1 ? sel[0]! : null;
  const erd = sel.every((c) => touchesErd(c, byId));
  const end = (b: Shape["start"]) => (b?.shapeId && byId(b.shapeId) ? `${nameOf(byId(b.shapeId))} · ${b.port ?? b.anchor ?? "side"}` : "Not connected");
  const route = shared(sel, (c) => c.route ?? "straight");
  const avoid = shared(sel, (c) => c.routing === "avoid");
  return (
    <>
      {one ? (
        <Sec title="Ends">
          <dl className="ocpp-ends">
            <dt>From</dt>
            <dd>{end(one.start)}</dd>
            <dt>To</dt>
            <dd>{end(one.end)}</dd>
          </dl>
        </Sec>
      ) : null}
      <Sec title="Label">
        <Text label="Text" value={shared(sel, (c) => c.text ?? "")} edit={edit} placeholder="Add a label" onCommit={(text) => field({ text })} />
      </Sec>
      <Sec title="Route">
        <div className="ocdg-seg" role="radiogroup" aria-label="Style">
          {(["straight", "elbow"] as const).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={route === r} disabled={!edit} onClick={() => field(r === "elbow" ? { route: r } : { route: r, routing: undefined })}>
              {r === "straight" ? "Straight" : "Elbow"}
            </button>
          ))}
        </div>
        <Check label="Avoid shapes" hint="Bends go around other shapes" value={avoid} edit={edit} onChange={(v) => field(v ? { route: "elbow", routing: "avoid" } : { routing: undefined })} />
      </Sec>
      {erd ? (
        <Sec title="Cardinality">
          <Select label="Start" value={shared(sel, (c) => propOf<string>(c, "startCard") ?? "one")} options={CARDINALITY} edit={edit} onChange={(v) => v && prop("startCard", v)} />
          <Select label="End" value={shared(sel, (c) => propOf<string>(c, "endCard") ?? "zero-many")} options={CARDINALITY} edit={edit} onChange={(v) => v && prop("endCard", v)} />
        </Sec>
      ) : (
        <Sec title="Line">
          <Select label="Start arrow" value={shared(sel, (c) => propOf<string>(c, "startArrow") ?? "none")} options={ARROWS} edit={edit} onChange={(v) => v && prop("startArrow", v)} />
          <Select label="End arrow" value={shared(sel, (c) => propOf<string>(c, "endArrow") ?? "arrow")} options={ARROWS} edit={edit} onChange={(v) => v && prop("endArrow", v)} />
          <div className="ocdg-seg" role="radiogroup" aria-label="Pattern">
            {(["solid", "dashed", "dotted"] as const).map((v) => {
              const cur = shared(sel, (c) => propOf<string>(c, "pattern") ?? (c.dashed ? "dashed" : "solid"));
              return (
                <button key={v} type="button" role="radio" aria-checked={cur === v} disabled={!edit} onClick={() => (prop("pattern", v), field({ dashed: v !== "solid" }))}>
                  {v[0]!.toUpperCase() + v.slice(1)}
                </button>
              );
            })}
          </div>
        </Sec>
      )}
    </>
  );
}
