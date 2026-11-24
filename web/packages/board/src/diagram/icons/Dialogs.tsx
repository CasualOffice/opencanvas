// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Add your own icon (DGM-17, approved frames 2a-2d, 2f) and Icons in this document (3b-3d).
// The server cleans every file (`env.icons`, `POST /v1/icons`) and writes the document's
// `icons` root; this side only shows what the server said and asks for a name. Phone (7a-7d):
// the dialogs become full-height sheets under 30em.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { AlertTriangle, Check, ClipboardPaste, Download, FileCode2, ImagePlus, MoreHorizontal, Pencil, Replace, Search, Trash2, Upload, X } from "lucide-react";
import { IconError, type IconApi, type IconCheck } from "@opencanvas/ui";
import { readShapes } from "../../model";
import { DOC_PREFIX, ICON_KIND, docIconUrl, iconProps, type DocIcon } from "../../icons";
import { MAX_DOC_ICONS, MAX_DOC_ICON_BYTES } from "../../icons";
import { ensureIconStyles } from "./styles";

const SW = 1.75;

/** "jitsi-logo.svg" → "Jitsi logo". */
export function nameFromFile(file: string): string {
  const base = file.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Icon";
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`);

/** How many shapes use each document icon, and on how many boards. */
export function iconUsage(doc: Y.Doc): Map<string, { shapes: number; boards: number }> {
  const out = new Map<string, { shapes: number; boards: number }>();
  doc.getMap("boards").forEach((b) => {
    if (!(b instanceof Y.Map)) return;
    const seen = new Set<string>();
    for (const s of readShapes(b as Y.Map<unknown>)) {
      if (s.kind !== ICON_KIND) continue;
      const icon = iconProps(s).icon;
      if (!icon?.startsWith(DOC_PREFIX)) continue;
      const id = icon.slice(DOC_PREFIX.length);
      const u = out.get(id) ?? { shapes: 0, boards: 0 };
      u.shapes++;
      if (!seen.has(id)) (u.boards++, seen.add(id));
      out.set(id, u);
    }
  });
  return out;
}

function Dialog({ title, id, onClose, children, footer, wide }: { title: ReactNode; id: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ensureIconStyles();
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button,input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="ocdg-scrim ocic-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`ocdg-dlg ocic-dlg${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="ocdg-dh">
          <h2 id={id}>{title}</h2>
          <button type="button" className="ocdg-ib" aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={SW} />
          </button>
        </header>
        <div className="ocic-body">{children}</div>
        <footer className="ocdg-df">{footer}</footer>
      </div>
    </div>
  );
}

/** Keywords as one comma-separated field: typed as text, stored as a list. */
const splitKeywords = (v: string) => [...new Set(v.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 12);

const REASONS: [string, string][] = [
  ["Not an SVG or PNG", "A renamed PDF, HTML or a JPEG; we check the content, not the name"],
  ["Nothing left to show", "After cleaning there is nothing visible, for example an SVG that is only a script"],
  ["Too deep or too large", "More than 16 nested groups, more than 2,000 shapes, or a PNG over 1024 × 1024"],
  ["The document is full", "200 icons, or 1 MB of icons, in this document"],
];

type Step = { s: "empty" } | { s: "checking"; file: File } | { s: "checked"; file: File; check: IconCheck } | { s: "refused"; file: File; message: string } | { s: "adding"; file: File; check: IconCheck };

/** Add an icon to this document (2a-2d). `replace` swaps the file of an existing icon. */
export function AddIcon({ api, file, replace, onClose, onAdded }: { api?: IconApi; file?: File; replace?: DocIcon; onClose: () => void; onAdded: (id: string) => void }) {
  const [step, setStep] = useState<Step>({ s: "empty" });
  const [name, setName] = useState(replace?.name ?? "");
  const [keywords, setKeywords] = useState(replace?.keywords.join(", ") ?? "");
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const check = async (f: File) => {
    setError("");
    if (!api) return setStep({ s: "refused", file: f, message: "Adding icons needs the OpenCanvas server." });
    setStep({ s: "checking", file: f });
    if (!replace) setName((n) => n || nameFromFile(f.name));
    try {
      setStep({ s: "checked", file: f, check: await api.check(f) });
    } catch (e) {
      setStep({ s: "refused", file: f, message: e instanceof IconError ? e.message : "The file could not be checked. Try again." });
    }
  };
  // A file handed in (paste toast, 2e) is checked straight away.
  useEffect(() => {
    if (file) void check(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ⌘V / Ctrl+V while the dialog is open pastes an SVG or PNG.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type === "image/svg+xml" || x.type === "image/png");
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (f) {
        e.preventDefault();
        void check(f);
      } else if (/^\s*<svg[\s>]/i.test(text)) {
        e.preventDefault();
        void check(new File([text], "pasted.svg", { type: "image/svg+xml" }));
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async () => {
    if (step.s !== "checked") return;
    const n = name.trim();
    if (!replace && !n) return setError("Give the icon a name.");
    setStep({ s: "adding", file: step.file, check: step.check });
    try {
      if (replace) {
        await api!.replace(replace.id, step.file);
        onAdded(replace.id);
      } else {
        const { id } = await api!.add(step.file, n, splitKeywords(keywords));
        onAdded(id);
      }
    } catch (e) {
      setStep({ s: "checked", file: step.file, check: step.check });
      setError(e instanceof IconError ? e.message : "The icon could not be added. Try again.");
    }
  };

  const chooser = (
    <input
      ref={input}
      type="file"
      accept=".svg,.png,image/svg+xml,image/png"
      className="ocdg-sr"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const f = e.currentTarget.files?.[0];
        if (f) void check(f);
        e.currentTarget.value = "";
      }}
    />
  );
  const title = replace ? `Replace the file of “${replace.name}”` : "Add an icon to this document";
  const fileRow = step.s !== "empty" ? (
    <div className="ocic-file">
      <FileCode2 size={16} strokeWidth={SW} aria-hidden="true" />
      <span className="ocic-fn">{step.file.name}</span>
      <span className="ocdg-hint">{step.s === "checked" || step.s === "adding" ? `${kb(step.file.size)}${step.file.size !== step.check.bytes ? ` → ${kb(step.check.bytes)} after cleaning` : ""} · ${step.check.format.toUpperCase()}` : kb(step.file.size)}</span>
      <button type="button" className="ocdg-sec-b" onClick={() => input.current?.click()}>
        Choose another
      </button>
    </div>
  ) : null;

  let body: ReactNode;
  if (step.s === "empty") {
    body = (
      <>
        <div
          className={`ocic-drop${over ? " over" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void check(f);
          }}
        >
          <ImagePlus size={24} strokeWidth={SW} aria-hidden="true" />
          <p>
            <b>Drop an SVG or PNG here</b>
          </p>
          <p className="ocic-or">
            or{" "}
            <button type="button" className="ocdg-pri" onClick={() => input.current?.click()}>
              <Upload size={14} strokeWidth={SW} />
              Choose file
            </button>{" "}
            <span className="ocdg-hint">
              <ClipboardPaste size={12} strokeWidth={SW} aria-hidden="true" /> Paste ⌘V
            </span>
          </p>
        </div>
        <ul className="ocic-lims">
          <li>SVG up to 256 KB</li>
          <li>PNG up to 256 KB, 1024 × 1024</li>
          <li>Up to 200 icons per document</li>
        </ul>
        <p className="ocic-note">Only add logos and icons you are allowed to use. Product logos belong to their owners; many brands have rules about how their logo may appear. Icons are cleaned on the server before anyone sees them.</p>
      </>
    );
  } else if (step.s === "checking") {
    body = (
      <>
        {fileRow}
        <p className="ocdg-hint" role="status">Checking the file on the server…</p>
      </>
    );
  } else if (step.s === "refused") {
    body = (
      <>
        {fileRow}
        <div className="ocic-refused" role="alert">
          <AlertTriangle size={16} strokeWidth={SW} aria-hidden="true" />
          <div>
            <p>
              <b>This file can’t be used as an icon.</b>
            </p>
            <p>{step.message}</p>
          </div>
        </div>
        <h3 className="ocdg-sh">Other reasons a file is refused</h3>
        <ul className="ocic-reasons">
          {REASONS.map(([t, d]) => (
            <li key={t}>
              <b>{t}</b>
              <span className="ocdg-hint">{d}</span>
            </li>
          ))}
        </ul>
      </>
    );
  } else {
    const c = step.check;
    const removed = c.removed.reduce((n, r) => n + r.count, 0);
    body = (
      <>
        {fileRow}
        <div className="ocic-pvs">
          {(["light", "dark"] as const).map((t) => (
            <div key={t} className="ocic-pvrow ocdg-aipv" data-theme-pv={t}>
              <span className="ocdg-hint">{t === "light" ? "Light" : "Dark"}</span>
              {[16, 24, 48].map((px) => (
                <img key={px} src={c.dataUrl} alt="" width={px} height={px} style={{ width: `${px / 16}rem`, height: `${px / 16}rem` }} />
              ))}
            </div>
          ))}
        </div>
        {removed ? (
          <section className="ocic-report" aria-labelledby="ocic-rep">
            <h3 className="ocdg-sh" id="ocic-rep">{`We removed ${removed} ${removed === 1 ? "thing" : "things"} that icons can’t contain`}</h3>
            <p className="ocdg-hint">The picture is unchanged. The cleaned copy is what is stored and shared.</p>
            <ul className="ocdg-items">
              {c.removed.map((r) => (
                <li key={r.what} className="ocdg-item" data-level="gray">
                  <Check size={14} strokeWidth={SW} aria-hidden="true" />
                  <span className="ocdg-it">{r.what}</span>
                  <span className="ocdg-cnt">{r.count}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="ocic-ok">
            <Check size={14} strokeWidth={SW} aria-hidden="true" /> Checked: nothing to remove. {`${kb(c.bytes)}, ${c.format.toUpperCase()}.`}
          </p>
        )}
        {replace ? null : (
          <div className="ocic-fields">
            <label className="ocdg-fld">
              <span className="ocdg-lbl">Name</span>
              <input className="ocdg-inp" aria-label="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="ocdg-fld">
              <span className="ocdg-lbl">Keywords</span>
              <input className="ocdg-inp" aria-label="Keywords" value={keywords} placeholder="video, meetings" onChange={(e) => setKeywords(e.target.value)} />
            </label>
          </div>
        )}
        {error ? (
          <p className="ocdg-err" role="alert">
            {error}
          </p>
        ) : null}
      </>
    );
  }

  const footer =
    step.s === "refused" ? (
      <>
        <button type="button" className="ocdg-sec-b" onClick={onClose}>
          Close
        </button>
        <button type="button" className="ocdg-pri" onClick={() => input.current?.click()}>
          Choose another file
        </button>
      </>
    ) : (
      <>
        <button type="button" className="ocdg-sec-b" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ocdg-pri" disabled={step.s !== "checked"} onClick={() => void add()}>
          {replace ? "Replace file" : "Add icon"}
        </button>
      </>
    );
  return (
    <Dialog title={title} id="ocdg-ai-t" onClose={onClose} footer={footer}>
      {chooser}
      {body}
    </Dialog>
  );
}

/** Icons in this document (3b-3d): rename, replace, download, remove. */
export function ManageIcons({ doc, list, api, onClose, onAdd, onReplace }: { doc: Y.Doc; list: DocIcon[]; api?: IconApi; onClose: () => void; onAdd: () => void; onReplace: (i: DocIcon) => void }) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; keywords: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DocIcon | null>(null);
  const [error, setError] = useState("");
  const usage = useMemo(() => iconUsage(doc), [doc, list]);
  const shown = list.filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()) || i.keywords.some((k) => k.includes(q.trim().toLowerCase())));
  const total = list.reduce((n, i) => n + i.bytes, 0);
  const run = async (f: () => Promise<void>) => {
    setError("");
    try {
      await f();
    } catch (e) {
      setError(e instanceof IconError ? e.message : "That didn’t work. Try again.");
    }
  };
  const download = (i: DocIcon) => {
    const url = docIconUrl(i);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${i.name.replace(/[^\p{L}\p{N} ._-]/gu, "_") || "icon"}.${i.format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const dateOf = (at: string) => {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return "";
    return d.toDateString() === new Date().toDateString() ? "today" : d.toLocaleDateString("en", { month: "short", day: "numeric" });
  };
  const u = removing ? usage.get(removing.id) : undefined;
  return (
    <>
      <Dialog
        title="Icons in this document"
        id="ocdg-mi-t"
        wide
        onClose={() => (removing ? setRemoving(null) : onClose())}
        footer={
          <>
            <span className="ocdg-hint ocic-sp">Everyone who can edit this document can add and change these icons.</span>
            <button type="button" className="ocdg-pri" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <div className="ocic-mtop">
          <div className="ocdg-search ocic-filter">
            <Search size={14} strokeWidth={SW} aria-hidden="true" />
            <input type="search" aria-label="Filter icons" placeholder="Filter icons" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button type="button" className="ocdg-pri" disabled={!api} onClick={onAdd}>
            <ImagePlus size={14} strokeWidth={SW} />
            Add icon
          </button>
        </div>
        {list.length ? null : <p className="ocdg-hint">No icons yet. Logos and icons you add are kept in this document, so everyone here can reuse them.</p>}
        <ul className="ocic-rows">
          {shown.map((i) => {
            const url = docIconUrl(i);
            const used = usage.get(i.id)?.shapes ?? 0;
            return (
              <li key={i.id} className="ocic-row">
                {url ? <img src={url} alt="" className="ocic-th" /> : <span className="ocic-th" />}
                {editing?.id === i.id ? (
                  <form
                    className="ocic-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const n = editing.name.trim();
                      if (!n || !api) return;
                      void run(async () => {
                        await api.rename(i.id, n, splitKeywords(editing.keywords));
                        setEditing(null);
                      });
                    }}
                  >
                    <input className="ocdg-inp" aria-label="Name" value={editing.name} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    <input className="ocdg-inp" aria-label="Keywords" value={editing.keywords} onChange={(e) => setEditing({ ...editing, keywords: e.target.value })} />
                    <button type="submit" className="ocdg-pri">
                      Save
                    </button>
                    <button type="button" className="ocdg-sec-b" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <span className="ocic-t">
                    <b>{i.name}</b>
                    <span className="ocdg-hint">{i.keywords.join(", ")}</span>
                  </span>
                )}
                <span className="ocdg-hint">{`${i.format.toUpperCase()} · ${kb(i.bytes)}`}</span>
                <span className="ocdg-hint">{used ? `Used ${used}×` : "Not used"}</span>
                <span className="ocdg-hint ocic-by">{[i.byName, dateOf(i.at)].filter(Boolean).join(" · ")}</span>
                {api ? (
                  <span className="ocic-acts">
                    <button type="button" className="ocdg-ib" aria-label={`Rename ${i.name}`} title="Rename and keywords" onClick={() => setEditing({ id: i.id, name: i.name, keywords: i.keywords.join(", ") })}>
                      <Pencil size={14} strokeWidth={SW} />
                    </button>
                    <button type="button" className="ocdg-ib" aria-label={`More for ${i.name}`} aria-haspopup="menu" aria-expanded={menu === i.id} onClick={() => setMenu((m) => (m === i.id ? null : i.id))}>
                      <MoreHorizontal size={14} strokeWidth={SW} />
                    </button>
                    <button type="button" className="ocdg-ib" aria-label={`Remove ${i.name}`} title="Remove from document" onClick={() => setRemoving(i)}>
                      <Trash2 size={14} strokeWidth={SW} />
                    </button>
                    {menu === i.id ? (
                      <span className="ocic-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => (setMenu(null), onReplace(i))}>
                          <Replace size={14} strokeWidth={SW} />
                          {`Replace file${used ? ` (updates ${used === 1 ? "1 shape" : `all ${used} shapes`})` : ""}`}
                        </button>
                        <button type="button" role="menuitem" onClick={() => (setMenu(null), download(i))}>
                          <Download size={14} strokeWidth={SW} />
                          {i.format === "svg" ? "Download cleaned SVG" : "Download PNG"}
                        </button>
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {error ? (
          <p className="ocdg-err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="ocic-meter" role="meter" aria-label="Icon allowance" aria-valuemin={0} aria-valuemax={MAX_DOC_ICON_BYTES} aria-valuenow={total}>
          <i style={{ width: `${Math.min(100, (total / MAX_DOC_ICON_BYTES) * 100)}%` }} />
        </div>
        <p className="ocdg-hint">{`${kb(total)} of 1 MB for icons · ${list.length} of ${MAX_DOC_ICONS}`}</p>
      </Dialog>
      {removing ? (
        <div className="ocdg-scrim ocic-scrim ocic-top">
          <div className="ocdg-dlg ocic-dlg ocic-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ocic-rm-t">
            <header className="ocdg-dh">
              <h2 id="ocic-rm-t">{`Remove “${removing.name}”?`}</h2>
            </header>
            <div className="ocic-body">
              <p>{u?.shapes ? `It is used by ${u.shapes === 1 ? "1 shape" : `${u.shapes} shapes`} on ${u.boards === 1 ? "1 board" : `${u.boards} boards`}. They keep their labels and connections and show an empty icon frame until you pick another icon.` : "No shape uses it."}</p>
              {u?.shapes ? <p className="ocdg-hint">To change the picture everywhere instead, use Replace file.</p> : null}
            </div>
            <footer className="ocdg-df">
              <button type="button" className="ocdg-sec-b" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              {u?.shapes ? (
                <button type="button" className="ocdg-sec-b" onClick={() => (setRemoving(null), onReplace(removing))}>
                  Replace file instead
                </button>
              ) : null}
              <button
                type="button"
                className="ocdg-pri ocic-danger"
                onClick={() => {
                  const r = removing;
                  setRemoving(null);
                  void run(() => api!.remove(r.id));
                }}
              >
                Remove
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}

export type IconDialogState = { kind: "add"; file?: File; replace?: DocIcon } | { kind: "manage" };

/** The icon dialogs of one board (loaded lazily with this module). */
export function IconDialogs({ state, doc, list, api, onState, onAdded }: { state: IconDialogState; doc: Y.Doc; list: DocIcon[]; api?: IconApi; onState: (s: IconDialogState | null) => void; onAdded: (id: string) => void }) {
  if (state.kind === "manage") {
    return <ManageIcons doc={doc} list={list} api={api} onClose={() => onState(null)} onAdd={() => onState({ kind: "add" })} onReplace={(i) => onState({ kind: "add", replace: i })} />;
  }
  return (
    <AddIcon
      key={state.replace?.id ?? "new"}
      api={api}
      file={state.file}
      replace={state.replace}
      onClose={() => onState(state.replace ? { kind: "manage" } : null)}
      onAdded={(id) => (state.replace ? onState({ kind: "manage" }) : (onState(null), onAdded(id)))}
    />
  );
}
