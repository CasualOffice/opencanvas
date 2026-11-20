import { useRef, useState } from "react";
import { Ic } from "../icons";
import { resolveEmbed } from "../lib/embeds";
import { Modal, ModalHead } from "./overlay";

export function UrlPrompt({ kind, onClose, onUrl }: { kind: "bookmark" | "embed"; onClose(): void; onUrl(url: string): void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
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
          placeholder={kind === "embed" ? "https://www.youtube.com/watch?v=…" : "https://"}
          value={v}
          onChange={(e) => (setV(e.target.value), setErr(""))}
          aria-label="Link"
          inputMode="url"
        />
        {err ? <p style={{ color: "var(--red-fg)", fontSize: 12.5, margin: "8px 2px 0" }}>{err}</p> : null}
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
        {err ? <p style={{ color: "var(--red-fg)", fontSize: 12.5, margin: "10px 2px 0" }}>{err}</p> : null}
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
