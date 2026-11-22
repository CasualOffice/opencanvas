// docs/23 FC-10, prototype docs/prototypes/fixes-approved/Import.dc.html: "Import into this
// canvas". A drop zone for Markdown, HTML or CSV; a CSV gets a preview with a detected, changeable
// type per column and where to insert; then a done state. Lazy: never in the initial bundle.
//
// The server imports (`POST /v1/import?format=&ticket=&blockId=&types=`) and is authoritative; the
// types detected here are for the preview only. `#demo` parses and inserts in this browser.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import type { DbField, FieldType } from "@opencanvas/database";
import { Ic } from "../icons";
import { Modal } from "./overlay";
import { loadDatabase } from "../editor/blockdata";
import { topBlockAt } from "../editor/blockops";
import { ensureBlockIdAt } from "../editor/blockId";
import type { ImportFormat } from "../lib/importflag";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPE_LABEL: Partial<Record<FieldType, string>> = { text: "Text", title: "Text", number: "Number", date: "Date", checkbox: "Checkbox", url: "URL", person: "Person", tags: "Tags", status: "Status", progress: "Progress" };

type Csv = { name: string; text: string; rows: string[][]; fields: DbField[]; types: FieldType[] };
type Step = { s: "pick" } | { s: "csv"; csv: Csv } | { s: "busy" } | { s: "done"; text: string };

const formatOf = (f: File): ImportFormat | null =>
  /\.csv$/i.test(f.name) || f.type === "text/csv" ? "csv" : /\.html?$/i.test(f.name) || f.type === "text/html" ? "html" : /\.(md|markdown)$/i.test(f.name) || f.type === "text/markdown" ? "md" : null;

export function ImportInto({ editor, doc, ticket, formats, demo, onClose }: { editor: Editor; doc: Y.Doc; ticket: string | null; formats: ImportFormat[]; demo: boolean; onClose(): void }) {
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
      const j = (await r.json().catch(() => ({}))) as { rows?: number; blocks?: number; error?: { message?: string } };
      if (!r.ok) throw new Error(j.error?.message || "The import didn't work.");
      setStep({ s: "done", text: format === "csv" ? `Imported a database with ${j.rows ?? count(text)} rows` : blocksText(j.blocks ?? 1) });
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "The import didn't work. Try again.");
      setStep({ s: "pick" });
    }
  };

  const take = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    const format = formatOf(f);
    if (!format || !formats.includes(format)) return setErr(`Choose a ${formats.map((x) => (x === "md" ? "Markdown" : x.toUpperCase())).join(", ")} file.`);
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
  const dataRows = csv ? csv.rows.length - 1 : 0;
  return (
    <Modal onClose={onClose} label="Import into this canvas" wide>
      <div className="imp">
        <div className="imp-hd">
          <Ic name="upload" />
          <div className="imp-t">
            <strong>Import into this canvas</strong>
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
              <span>Markdown (.md), HTML (.html) or CSV (.csv), up to 5 MB</span>
            </button>
            <input ref={input} type="file" hidden aria-label="Choose a file to import" accept=".md,.markdown,.html,.htm,.csv,text/markdown,text/html,text/csv" onChange={(e) => void take(e.target.files?.[0])} />
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
              <span>
                <strong>Safe by default:</strong> scripts are removed and links are checked.
              </span>
            </div>
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

        {step.s === "done" ? (
          <div className="imp-done" role="status">
            <Ic name="check" size={24} className="imp-ok" />
            <strong>{step.text}</strong>
            <span>Undo with {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Z" : "Ctrl+Z"}, like any edit.</span>
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
