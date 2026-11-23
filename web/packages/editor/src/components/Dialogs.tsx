// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { useRef, useState } from "react";
import { Ic } from "../icons";
import { PROVIDERS, resolveEmbed, type Provider } from "../lib/embeds";
import { Modal, ModalHead } from "./overlay";

export function UrlPrompt({ kind, onClose, onUrl }: { kind: "bookmark" | "embed"; onClose(): void; onUrl(url: string): void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const [want, setWant] = useState<Provider | null>(null);
  const detected = kind === "embed" ? resolveEmbed(/^https?:\/\//i.test(v.trim()) ? v.trim() : "https://" + v.trim()) : null;
  const shownProvider = detected?.provider ?? want;
  const submit = () => {
    let url = v.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      new URL(url);
    } catch {
      return setErr("That doesn't look like a link.");
    }
    if (kind === "embed" && !resolveEmbed(url)) return setErr("Only YouTube, Vimeo, Loom, Figma and Google Maps links can be embedded.");
    onUrl(url);
    onClose();
  };
  return (
    <Modal onClose={onClose} label={kind === "embed" ? "Embed" : "Link preview"}>
      <ModalHead
        title={kind === "embed" ? "Embed" : "Link preview"}
        sub={kind === "embed" ? "Videos, designs and maps play in a sandboxed frame." : "Shows the page as a card in the canvas."}
        onClose={onClose}
      />
      <form
        className="mbd"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="pin"
          data-autofocus
          placeholder={kind === "embed" ? (PROVIDERS.find((p) => p.id === want)?.example ?? "Paste a video, design or map link") : "https://"}
          value={v}
          onChange={(e) => (setV(e.target.value), setErr(""))}
          aria-label={kind === "embed" ? "Embed link" : "Link"}
          aria-invalid={!!err}
          aria-describedby={err ? "url-err" : undefined}
          inputMode="url"
        />
        {kind === "embed" ? (
          <div className="provs" role="radiogroup" aria-label="Provider">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={shownProvider === p.id}
                className={"chip" + (shownProvider === p.id ? " on" : "")}
                onClick={() => setWant(p.id)}
              >
                <Ic name={p.icon} size={14} />
                {p.label}
                {detected?.provider === p.id ? <Ic name="check" size={13} /> : null}
              </button>
            ))}
          </div>
        ) : null}
        {err ? (
          <p id="url-err" role="alert" style={{ color: "var(--red-fg)", fontSize: ".7813rem", margin: ".5rem 2px 0" }}>
            {err}
          </p>
        ) : null}
      </form>
      <div className="mft">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={submit} disabled={!v.trim()}>
          {kind === "embed" ? "Embed" : "Add link"}
        </button>
      </div>
    </Modal>
  );
}

export type ImportResult = { kind: "md" | "html"; text: string; name: string } | { kind: "csv"; text: string; name: string };

/** Import a Markdown, HTML or CSV file into a fresh canvas. */
export function ImportDialog({ onClose, onImport, onPasteCsv }: { onClose(): void; onImport(r: ImportResult): void; onPasteCsv(): void }) {
  const [over, setOver] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const take = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setErr("That file is over 5 MB.");
    const text = await f.text();
    const name = f.name.replace(/\.[^.]+$/, "");
    if (/\.csv$/i.test(f.name) || f.type === "text/csv") onImport({ kind: "csv", text, name });
    else if (/\.html?$/i.test(f.name) || f.type === "text/html") onImport({ kind: "html", text, name });
    else if (/\.(md|markdown|txt)$/i.test(f.name) || /markdown|text\/plain/.test(f.type)) onImport({ kind: "md", text, name });
    else return setErr("Choose a Markdown, HTML or CSV file.");
    onClose();
  };
  return (
    <Modal onClose={onClose} label="Import">
      <ModalHead title="Import into a new canvas" sub="Markdown and HTML become blocks. A CSV becomes a database." onClose={onClose} />
      <div className="mbd">
        <button
          className={"drop" + (over ? " over" : "")}
          onClick={() => input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void take(e.dataTransfer.files[0]);
          }}
        >
          <Ic name="upload" size={22} />
          <b>Drop a file here, or choose one</b>
          <span>.md · .html · .csv, up to 5 MB</span>
        </button>
        <input ref={input} type="file" hidden accept=".md,.markdown,.txt,.html,.htm,.csv,text/markdown,text/html,text/csv" onChange={(e) => void take(e.target.files?.[0])} />
        {err ? <p style={{ color: "var(--red-fg)", fontSize: ".7813rem", margin: ".625rem 2px 0" }}>{err}</p> : null}
      </div>
      <div className="mft">
        <button className="btn ghost" onClick={() => (onClose(), onPasteCsv())}>
          <Ic name="file-spreadsheet" size={14} />
          Paste CSV instead
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
