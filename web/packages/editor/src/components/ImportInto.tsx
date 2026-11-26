// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// docs/23 FC-10, prototype docs/prototypes/fixes-approved/Import.dc.html: "Import into this
// canvas". A drop zone for Markdown, HTML or CSV; a CSV gets a preview with a detected, changeable
// type per column and where to insert; then a done state. Lazy: never in the initial bundle.
// Diagram files (DGM-15, approved frames docs/prototypes/diagram-approved 7a-7e): draw.io and
// Excalidraw get a server dry run first (counts and every item that won't convert exactly), a
// refusal screen when the file can't be read, and the same done state with "Undo import".
//
// The server imports (`POST /v1/import?format=&ticket=&blockId=&types=`) and is authoritative; the
// types detected here are for the preview only. `#demo` parses and inserts in this browser.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import type { DbField, FieldType } from "@opencanvas/database";
import { Ic } from "../icons";
import { Modal } from "./overlay";
import { loadDatabase } from "../editor/blockdata";
import { topBlockAt } from "../editor/blockops";
import { blockDoc, blockMap } from "../lib/blocks";
import { ensureBlockIdAt } from "../editor/blockId";
import { DIAGRAM_FORMATS, type ImportFormat } from "../lib/importflag";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPE_LABEL: Partial<Record<FieldType, string>> = { text: "Text", title: "Text", number: "Number", date: "Date", checkbox: "Checkbox", url: "URL", person: "Person", tags: "Tags", status: "Status", progress: "Progress" };

type Csv = { name: string; text: string; rows: string[][]; fields: DbField[]; types: FieldType[] };
/** The server's dry-run report (`oc_model::diagram_import`). */
type ReportItem = { level: "warn" | "gray" | "ok"; code: string; title: string; detail?: string; count: number; examples: string[] };
type Report = { pages: string[]; page: number; counts: { shapes: number; connectors: number; needLook: number }; items: ReportItem[] };
type Diagram = { name: string; format: ImportFormat; file: Blob; report: Report };
type Step =
  | { s: "pick" }
  | { s: "csv"; csv: Csv }
  | { s: "busy" }
  | { s: "diagram"; d: Diagram; busy?: boolean }
  | { s: "refused"; name: string; text: string }
  | { s: "done"; text: string; sub?: string; undo?: string[]; undoShapes?: string[] }
  | { s: "undone" };

const FORMAT_NAME: Record<ImportFormat, string> = { md: "Markdown", html: "HTML", csv: "CSV", drawio: "draw.io", excalidraw: "Excalidraw" };
const list = (xs: string[], last = "or") => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${last} ${xs[xs.length - 1]}`);
const mb = (n: number) => (n < 100 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const REPORT_ICON: Record<string, string> = { stencil: "puzzle", shape_box: "puzzle", image_large: "image-off", image_svg: "image-off", image_type: "image-off", image_link: "image-off", page_other: "file-stack", containers: "square-dashed", curved: "corner-down-right", elbow: "corner-down-right" };
const levelIcon = (i: ReportItem) => REPORT_ICON[i.code] ?? (i.level === "warn" ? "triangle-alert" : i.level === "ok" ? "circle-check" : "info");

/** Removes these shapes from board `boardId` in one transaction ("Undo import" in diagram mode). */
function removeShapes(doc: Y.Doc, boardId: string, ids: string[]) {
  const b = blockMap(doc, "boards", boardId);
  if (!b) return;
  doc = blockDoc(doc, boardId);
  const want = new Set(ids);
  doc.transact(() => {
    const shapes = b.get("shapes");
    if (shapes instanceof Y.Map) for (const id of ids) shapes.delete(id);
    const order = b.get("order");
    if (order instanceof Y.Array) {
      const arr = order.toArray();
      for (let i = arr.length - 1; i >= 0; i--) if (want.has(arr[i] as string)) order.delete(i, 1);
    }
  });
}

/** Removes the top-level blocks with these `blockId`s in one transaction (an undoable local edit). */
function removeBlocks(editor: Editor, ids: string[]): number {
  const want = new Set(ids);
  const ranges: [number, number][] = [];
  editor.state.doc.forEach((node, offset) => {
    if (want.has(node.attrs.blockId as string)) ranges.push([offset, offset + node.nodeSize]);
  });
  if (!ranges.length) return 0;
  const tr = editor.state.tr;
  for (const [from, to] of ranges.reverse()) tr.delete(from, to);
  editor.view.dispatch(tr);
  return ranges.length;
}

const formatOf = (f: File): ImportFormat | null =>
  /\.(drawio|xml)$/i.test(f.name) ? "drawio" : /\.excalidraw$/i.test(f.name) ? "excalidraw" :
  /\.csv$/i.test(f.name) || f.type === "text/csv" ? "csv" : /\.html?$/i.test(f.name) || f.type === "text/html" ? "html" : /\.(md|markdown)$/i.test(f.name) || f.type === "text/markdown" ? "md" : null;

export function ImportInto({ editor, doc, ticket, formats: all, demo, onClose, boardId = null }: { editor: Editor; doc: Y.Doc; ticket: string | null; formats: ImportFormat[]; demo: boolean; onClose(): void; /** Diagram mode (DGM-14.6): add to this board; diagram files only. */ boardId?: string | null }) {
  const formats = boardId ? all.filter((x) => DIAGRAM_FORMATS.includes(x)) : all;
  const [step, setStep] = useState<Step>({ s: "pick" });
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Where to insert: after the block with the caret (when there is one), or at the end.
  const caret = useMemo(() => {
    const b = editor.state.doc.childCount > 1 || editor.state.doc.textContent ? topBlockAt(editor.state, editor.state.selection.from) : null;
    const label = b?.node.textContent.trim().slice(0, 40);
    return b && label ? { pos: b.pos, end: b.pos + b.node.nodeSize, label } : null;
  }, [editor]);
  const [where, setWhere] = useState<"after" | "end">(caret ? "after" : "end");
  useEffect(() => void loadDatabase(), []);

  const target = () => {
    if (where === "after" && caret) return { pos: caret.end, blockId: ensureBlockIdAt(editor, caret.pos + 1) };
    return { pos: editor.state.doc.content.size, blockId: null };
  };

  const run = async (format: ImportFormat, name: string, text: string, file: Blob, types?: FieldType[]) => {
    setStep({ s: "busy" });
    setErr("");
    const t = target();
    try {
      if (demo) {
        if (format === "csv") {
          const { importCsvToDatabase } = await loadDatabase();
          const id = importCsvToDatabase(doc, text, name, { types });
          editor.chain().insertContentAt(t.pos, [{ type: "database", attrs: { dbId: id } }]).run();
          return setStep({ s: "done", text: `Imported a database with ${count(text)} rows` });
        }
        const html = format === "md" ? ((await import("marked")).marked.parse(text, { async: false }) as string) : text;
        const before = editor.state.doc.childCount;
        editor.chain().insertContentAt(t.pos, html).run();
        return setStep({ s: "done", text: blocksText(Math.max(1, editor.state.doc.childCount - before)) });
      }
      const q = new URLSearchParams({ format, ticket: ticket ?? "" });
      if (t.blockId) q.set("blockId", t.blockId);
      if (format === "csv") {
        q.set("name", name);
        if (types) q.set("types", JSON.stringify(types));
      }
      // The block id set just now reaches the room with the next update (≤ 50 ms).
      if (t.blockId) await new Promise((r) => setTimeout(r, 120));
      const r = await fetch(`/v1/import?${q}`, { method: "POST", body: file, headers: { "Content-Type": format === "csv" ? "text/csv" : format === "html" ? "text/html" : "text/markdown" } });
      const j = (await r.json().catch(() => ({}))) as { rows?: number; blocks?: number; blockIds?: string[]; error?: { message?: string } };
      if (!r.ok) throw new Error(j.error?.message || "The import didn't work.");
      // The server made this edit, so it isn't in this browser's undo history: offer "Undo import".
      setStep({ s: "done", text: format === "csv" ? `Imported a database with ${j.rows ?? count(text)} rows` : blocksText(j.blocks ?? 1), undo: j.blockIds ?? [] });
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "The import didn't work. Try again.");
      setStep({ s: "pick" });
    }
  };

  // Diagrams: the server converts and reports first (dryRun=1), nothing is added until Import.
  const dryRun = async (name: string, format: ImportFormat, file: Blob, page: number, prev?: Diagram) => {
    setErr("");
    setStep(prev ? { s: "diagram", d: prev, busy: true } : { s: "busy" });
    try {
      const q = new URLSearchParams({ format, ticket: ticket ?? "", dryRun: "1", page: String(page) });
      const r = await fetch(`/v1/import?${q}`, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
      const j = (await r.json().catch(() => ({}))) as { report?: Report; error?: { message?: string } };
      if (!r.ok || !j.report) return setStep({ s: "refused", name, text: j.error?.message || "It couldn't be read." });
      setStep({ s: "diagram", d: { name, format, file, report: j.report } });
    } catch {
      setStep({ s: "refused", name, text: "The import server couldn't be reached. Try again." });
    }
  };

  const importDiagram = async (d: Diagram) => {
    setStep({ s: "diagram", d, busy: true });
    setErr("");
    const t = target();
    try {
      const q = new URLSearchParams({ format: d.format, ticket: ticket ?? "", page: String(d.report.page) });
      if (boardId) q.set("boardId", boardId);
      else if (t.blockId) q.set("blockId", t.blockId);
      if (!boardId && t.blockId) await new Promise((r) => setTimeout(r, 120));
      const r = await fetch(`/v1/import?${q}`, { method: "POST", body: d.file, headers: { "Content-Type": "application/octet-stream" } });
      const j = (await r.json().catch(() => ({}))) as { shapes?: number; connectors?: number; blockIds?: string[]; shapeIds?: string[]; error?: { message?: string } };
      if (!r.ok) return setStep({ s: "refused", name: d.name, text: j.error?.message || "The import didn't work." });
      const boxes = d.report.items.filter((i) => i.code === "stencil" || i.code === "shape_box").reduce((n, i) => n + i.count, 0);
      const shapes = j.shapes ?? d.report.counts.shapes, connectors = j.connectors ?? d.report.counts.connectors;
      setStep({
        s: "done",
        text: `Imported ${shapes} shape${shapes === 1 ? "" : "s"} and ${connectors} connector${connectors === 1 ? "" : "s"}`,
        sub: boxes ? `${boxes} became plain box${boxes === 1 ? "" : "es"}.` : "",
        undo: boardId ? [] : (j.blockIds ?? []),
        undoShapes: boardId ? (j.shapeIds ?? []) : undefined,
      });
    } catch {
      setErr("The import didn't work. Try again.");
      setStep({ s: "diagram", d });
    }
  };

  const take = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    const format = formatOf(f);
    if (!format || !formats.includes(format)) return setErr(`Choose a ${list(formats.map((x) => FORMAT_NAME[x]))} file.`);
    if (DIAGRAM_FORMATS.includes(format)) {
      if (f.size > MAX_BYTES)
        return setStep({ s: "refused", name: f.name, text: `is ${mb(f.size)}, and files can be up to 5 MB. ${format === "drawio" ? "In draw.io, export one page or remove large images" : "In Excalidraw, remove large images"}, then try again.` });
      return void dryRun(f.name, format, f, 0);
    }
    if (f.size > MAX_BYTES) return setErr("That file is over 5 MB.");
    const text = await f.text();
    const name = f.name.replace(/\.[^.]+$/, "");
    if (format !== "csv") return void run(format, name, text, f);
    const { parseCsv, detectFields } = await loadDatabase();
    const rows = parseCsv(text);
    if (!rows.length) return setErr("That CSV is empty.");
    const fields = detectFields(rows);
    setStep({ s: "csv", csv: { name: f.name, text, rows, fields, types: fields.map((x) => (x.type === "title" ? "text" : x.type)) } });
  };

  const csv = step.s === "csv" ? step.csv : null;
  const dia = step.s === "diagram" ? step.d : null;
  const diagrams = formats.filter((x) => DIAGRAM_FORMATS.includes(x));
  const dataRows = csv ? csv.rows.length - 1 : 0;
  return (
    <Modal onClose={onClose} label={boardId ? "Import into this diagram" : "Import into this canvas"} wide>
      <div className="imp">
        <div className="imp-hd">
          <Ic name="upload" />
          <div className="imp-t">
            <strong>{boardId ? "Import into this diagram" : "Import into this canvas"}</strong>
            {demo ? <span className="imp-demo">Demo: parsed in this browser, no import server</span> : null}
          </div>
          <button className="ib" aria-label="Close" onClick={onClose}>
            <Ic name="x" />
          </button>
        </div>

        {step.s === "pick" || step.s === "busy" ? (
          <div className="imp-bd">
            <button
              className={"imp-drop" + (over ? " over" : "")}
              disabled={step.s === "busy"}
              onClick={() => input.current?.click()}
              onDragOver={(e) => (e.preventDefault(), setOver(true))}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void take(e.dataTransfer.files[0]);
              }}
            >
              <Ic name={step.s === "busy" ? "loader-circle" : "file"} size={24} className={step.s === "busy" ? "spin" : ""} />
              <strong>{step.s === "busy" ? "Importing…" : "Drop a file here, or choose one"}</strong>
              <span>{diagrams.length ? `${list(formats.map((x) => FORMAT_NAME[x]))}, up to 5 MB` : "Markdown (.md), HTML (.html) or CSV (.csv), up to 5 MB"}</span>
            </button>
            <input
              ref={input}
              type="file"
              hidden
              aria-label="Choose a file to import"
              accept={".md,.markdown,.html,.htm,.csv,text/markdown,text/html,text/csv" + (diagrams.includes("drawio") ? ",.drawio,.xml" : "") + (diagrams.includes("excalidraw") ? ",.excalidraw" : "")}
              onChange={(e) => {
                void take(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {err ? (
              <p className="imp-err" role="alert">
                {err}
              </p>
            ) : null}
            <div className="imp-notes">
              <span>
                <strong>Markdown and HTML</strong> become text blocks, lists, tables and images.
              </span>
              <span>
                <strong>CSV</strong> becomes a database. You check the column types first.
              </span>
              {diagrams.length ? (
                <span>
                  <strong>{list(diagrams.map((x) => FORMAT_NAME[x]), "and")}</strong> {diagrams.length > 1 ? "become" : "becomes"} a diagram board. You see what converts before anything is added.
                </span>
              ) : (
                <span>
                  <strong>Safe by default:</strong> scripts are removed and links are checked.
                </span>
              )}
            </div>
            {diagrams.length ? (
              <p className="imp-safe">
                <strong>Safe by default:</strong> scripts, links in diagram files and embedded entities are removed.
              </p>
            ) : null}
          </div>
        ) : null}

        {csv ? (
          <>
            <div className="imp-bd">
              <div className="imp-file">
                <span className="imp-mono">{csv.name}</span>
                <span className="imp-mut">
                  · {dataRows} rows · {csv.fields.length} columns
                </span>
                <span className="imp-sp" />
                <button className="btn sm" onClick={() => setStep({ s: "pick" })}>
                  Choose another
                </button>
              </div>
              <div className="imp-tw">
                <table className="imp-tbl">
                  <thead>
                    <tr>
                      {csv.fields.map((f, i) => {
                        const det: FieldType = f.type === "title" ? "text" : f.type;
                        const opts: FieldType[] = det === "text" ? ["text"] : [det, "text"];
                        const lab = (t: FieldType) => (t === "select" ? `Select (${f.options?.length ?? 0} values)` : TYPE_LABEL[t] ?? t);
                        return (
                          <th key={f.id}>
                            <div className="imp-th">
                              <span>{f.name}</span>
                              <label>
                                Type{" "}
                                <select
                                  aria-label={`Type of ${f.name}`}
                                  value={csv.types[i]}
                                  onChange={(e) => {
                                    const types = csv.types.slice();
                                    types[i] = e.target.value as FieldType;
                                    setStep({ s: "csv", csv: { ...csv, types } });
                                  }}
                                >
                                  {opts.map((t) => (
                                    <option key={t} value={t}>
                                      {lab(t)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {csv.rows.slice(1, 4).map((r, ri) => (
                      <tr key={ri}>
                        {csv.fields.map((f, i) => (
                          <td key={f.id} className={(r[i] ?? "").trim() ? undefined : "imp-mut"}>
                            {(r[i] ?? "").trim() || "empty"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="imp-where">
                Insert{" "}
                <select aria-label="Where to insert" value={where} onChange={(e) => setWhere(e.target.value as "after" | "end")}>
                  {caret ? <option value="after">After “{caret.label}”</option> : null}
                  <option value="end">At the end</option>
                </select>
              </label>
              {err ? (
                <p className="imp-err" role="alert">
                  {err}
                </p>
              ) : null}
            </div>
            <div className="imp-ft">
              <button className="btn sm" onClick={() => setStep({ s: "pick" })}>
                Cancel
              </button>
              <button className="btn sm imp-pri" onClick={() => void run("csv", csv.name.replace(/\.[^.]+$/, ""), csv.text, new Blob([csv.text], { type: "text/csv" }), csv.types)}>
                Import {dataRows} rows
              </button>
            </div>
          </>
        ) : null}

        {dia && step.s === "diagram" ? (
          <>
            <div className="imp-bd" aria-busy={step.busy ? true : undefined}>
              <div className="imp-file">
                <Ic name="file-code-2" />
                <span className="imp-mono">{dia.name}</span>
                <span className="imp-mut">
                  {dia.report.pages.length > 1 ? `· ${dia.report.pages.length} pages ` : ""}· {mb(dia.file.size)}
                </span>
                <span className="imp-sp" />
                <button className="btn sm" onClick={() => setStep({ s: "pick" })}>
                  Choose another
                </button>
              </div>
              {dia.report.pages.length > 1 ? (
                <label className="imp-where">
                  Page{" "}
                  <select aria-label="Page" value={dia.report.page} disabled={step.busy} onChange={(e) => void dryRun(dia.name, dia.format, dia.file, Number(e.target.value), dia)}>
                    {dia.report.pages.map((p, i) => (
                      <option key={i} value={i}>
                        {p} (page {i + 1} of {dia.report.pages.length})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="imp-stats">
                <div className="imp-stat">
                  <b>{dia.report.counts.shapes}</b>
                  <span>
                    <Ic name="shapes" size={14} />
                    shapes
                  </span>
                </div>
                <div className="imp-stat">
                  <b>{dia.report.counts.connectors}</b>
                  <span>
                    <Ic name="workflow" size={14} />
                    connectors
                  </span>
                </div>
                <div className={"imp-stat" + (dia.report.counts.needLook ? " warn" : "")}>
                  <b>{dia.report.counts.needLook}</b>
                  <span>
                    <Ic name="triangle-alert" size={14} />
                    need a look
                  </span>
                </div>
              </div>
              {dia.report.items.length ? (
                <ul className="imp-rep" aria-label="What changes on the way in" tabIndex={0}>
                  {dia.report.items.map((it, i) => (
                    <li key={i} className={it.level}>
                      <Ic name={levelIcon(it)} size={16} />
                      <span className="t">
                        <b>{it.title}</b>
                        {it.detail ? <small>{it.detail}</small> : null}
                      </span>
                      {it.code !== "page_other" ? <span className="n">{it.count}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <label className="imp-where">
                Insert{" "}
                <select aria-label="Where to insert" value={where} onChange={(e) => setWhere(e.target.value as "after" | "end")}>
                  {caret ? <option value="after">After “{caret.label}”</option> : null}
                  <option value="end">At the end</option>
                </select>
              </label>
              {err ? (
                <p className="imp-err" role="alert">
                  {err}
                </p>
              ) : null}
            </div>
            <div className="imp-ft">
              <span className="imp-ft-note">Nothing is added until you import.</span>
              <button className="btn sm" onClick={() => setStep({ s: "pick" })}>
                Cancel
              </button>
              <button className="btn sm imp-pri" disabled={step.busy || !dia.report.counts.shapes} onClick={() => void importDiagram(dia)}>
                Import {dia.report.counts.shapes} shape{dia.report.counts.shapes === 1 ? "" : "s"}
              </button>
            </div>
          </>
        ) : null}

        {step.s === "refused" ? (
          <div className="imp-done imp-refuse" role="alert">
            <span className="imp-refuse-ic">
              <Ic name="file-x" size={22} />
            </span>
            <strong>This file can’t be imported</strong>
            <span>
              <span className="imp-mono">{step.name}</span> {step.text}
            </span>
            <div className="imp-done-acts">
              <button className="btn sm" onClick={() => setStep({ s: "pick" })}>
                Choose another file
              </button>
              <button className="btn sm ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : null}

        {step.s === "done" ? (
          <div className="imp-done" role="status">
            <Ic name="check" size={24} className="imp-ok" />
            <strong>{step.text}</strong>
            {step.sub ? <span>{step.sub}</span> : null}
            {step.undo && step.sub !== undefined ? (
              <span>Undo import removes all of it in one step.</span>
            ) : step.undo ? (
              <span>Not what you wanted? Undo removes everything this import added.</span>
            ) : (
              <span>Undo with {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Z" : "Ctrl+Z"}, like any edit.</span>
            )}
            <div className="imp-done-acts">
              {step.undoShapes?.length && boardId ? (
                <button className="btn sm" onClick={() => (removeShapes(doc, boardId, step.undoShapes ?? []), setStep({ s: "undone" }))}>
                  Undo import
                </button>
              ) : null}
              {step.undo?.length ? (
                <button className="btn sm" onClick={() => (removeBlocks(editor, step.undo ?? []), setStep({ s: "undone" }))}>
                  Undo import
                </button>
              ) : null}
              <button className="btn sm" onClick={() => setStep({ s: "pick" })}>
                Import another
              </button>
            </div>
          </div>
        ) : null}

        {step.s === "undone" ? (
          <div className="imp-done" role="status">
            <strong>Import removed</strong>
            <button className="btn sm" onClick={() => setStep({ s: "pick" })}>
              Import another
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

const count = (csv: string) => Math.max(0, csv.split(/\r?\n/).filter((l) => l.trim()).length - 1);
const blocksText = (n: number) => `Imported ${n} block${n === 1 ? "" : "s"}`;
