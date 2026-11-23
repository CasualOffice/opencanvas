// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheet, Info } from "lucide-react";
import type { BlockEnv } from "@opencanvas/ui";
import { detectFields, parseCsv } from "./csv";
import { FIELD_LABEL } from "./model";
import { ensureStyles } from "./styles";
import { Ic, Modal, TYPE_ICON } from "./ui";

export const SAMPLE_CSV = `Feature,Status,Owner,Votes,Requested,Customer
Per-channel autosave,Planned,Asha Rao,42,2026-11-02,Acme Schools
Comments in PDF export,In progress,Ravi Menon,31,2026-10-28,Acme Logistics
Offline mode on iOS,Planned,Lin Zhou,27,2026-11-10,Blue Fjord Energy
"Templates: ""Retro"" pack",Shipped,Priya Shah,19,2026-09-15,Acme Health
Database formulas,Planned,,55,2026-11-18,Orbit Studios`;

const MAX_ROWS = 10000;

export interface CsvImportDialogProps {
  open: boolean;
  env: BlockEnv;
  onClose(): void;
  onImport(csv: string): void;
  /** Override the dialog title (default "Import CSV"). */
  title?: string;
}

/** Paste / drop / choose a CSV, preview detected field types, then hand the text back. */
export function CsvImportDialog({ open, env, onClose, onImport, title }: CsvImportDialogProps) {
  ensureStyles();
  const [text, setText] = useState("");
  const [over, setOver] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setText("");
      setErr("");
    }
  }, [open]);

  const parsed = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
  const fields = useMemo(() => (parsed.length ? detectFields(parsed, [env.me, ...env.users]) : []), [parsed, env.me, env.users]);
  const data = parsed.slice(1);
  const ok = parsed.length >= 2 && data.length <= MAX_ROWS;

  if (!open) return <></>;

  const readFile = (f: File | undefined | null) => {
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) {
      setErr("That file is larger than 20 MB.");
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      setErr("");
      setText(String(fr.result ?? ""));
    };
    fr.onerror = () => setErr("Couldn't read that file.");
    fr.readAsText(f);
  };

  const submit = () => {
    if (!ok) {
      setErr(data.length > MAX_ROWS ? `That's ${data.length.toLocaleString()} rows. The limit is ${MAX_ROWS.toLocaleString()}.` : "Add a header row and at least one data row.");
      return;
    }
    onImport(text);
    onClose();
  };

  return (
    <Modal
      compact={env.compact}
      title={title ?? "Import CSV"}
      sub="Paste CSV or drop a .csv file. The first row becomes the field names, and each field type is detected for you."
      onClose={onClose}
      footer={
        <>
          <button className="ocdb-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ocdb-btn primary" onClick={submit} disabled={!ok}>
            Import{ok ? ` ${data.length} ${data.length === 1 ? "row" : "rows"}` : ""}
          </button>
        </>
      }
    >
      <div
        className={"ocdb-drop" + (over ? " over" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          readFile(e.dataTransfer.files[0]);
        }}
      >
        <Ic i={FileSpreadsheet} s={22} />
        <div>
          <b>Drop a CSV file</b> or{" "}
          <label>
            choose one
            <input ref={fileRef} type="file" accept=".csv,text/csv,.tsv,text/tab-separated-values" hidden onChange={(e) => readFile(e.target.files?.[0])} />
          </label>
        </div>
        <div style={{ fontSize: ".75rem" }}>Up to 10,000 rows. Commas or tabs.</div>
      </div>
      <div className="ocdb-or">
        <span>Or paste it here</span>
        <button className="ocdb-btn ghost sm" onClick={() => setText(SAMPLE_CSV)}>Use sample data</button>
      </div>
      <textarea
        className="ocdb-pin"
        value={text}
        onChange={(e) => {
          setErr("");
          setText(e.target.value);
        }}
        placeholder={"Name,Status,Owner\nKickoff,Done,Asha Rao"}
        aria-label="CSV text"
        spellCheck={false}
      />
      {parsed.length ? (
        <>
          <div className="ocdb-prev">
            <table>
              <thead>
                <tr>
                  {fields.map((f) => (
                    <th key={f.id}>
                      {f.name}
                      <small>
                        <Ic i={TYPE_ICON[f.type]} s={11} />
                        {FIELD_LABEL[f.type]}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {fields.map((_, j) => (
                      <td key={j}>{r[j] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ocdb-prevn">
            {data.length} {data.length === 1 ? "row" : "rows"} · {fields.length} {fields.length === 1 ? "field" : "fields"}
            {data.length > 5 ? " · showing the first 5" : ""}
          </div>
        </>
      ) : null}
      {err ? (
        <div className="ocdb-err" role="alert">
          <Ic i={Info} s={14} />
          {err}
        </div>
      ) : null}
    </Modal>
  );
}
