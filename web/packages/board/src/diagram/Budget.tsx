// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Size budget (DGM-14 S9, prototype 9a-9c; ADR-045 §7). A board may use a quarter of the document
// limit. The client measures the board's encoded size (its content encoded as a Yjs update, without
// history) after edits settle; amber from 80 %, red over 100 %. A soft limit: nothing is blocked,
// only the document limit (enforced by the server) stops saving.
//
// The session does not carry `max_doc_bytes` today (it is server config, `OC_MAX_DOC_MB`), so the
// shell takes it as an optional prop and falls back to the server default, 20 MB.
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { Gauge, X } from "lucide-react";
import { bbox, getBoardMap, readShapes } from "../model";

export const DEFAULT_MAX_DOC_BYTES = 20 * 1024 * 1024;
export const BOARD_SHARE = 0.25;
export const WARN_AT = 0.8;
const MB = 1024 * 1024;
const SW = 1.75;

export type Level = "ok" | "warn" | "over";
export const levelOf = (bytes: number, limit: number): Level => (bytes > limit ? "over" : bytes >= limit * WARN_AT ? "warn" : "ok");

/** "4.3 MB", "5 MB" (one decimal, a whole number without it); below 1 MB in whole KB ("12 KB"). */
export function mb(bytes: number): string {
  if (bytes < MB) return `${bytes <= 0 ? 0 : Math.min(1023, Math.max(1, Math.round(bytes / 1024)))} KB`;
  const v = Math.round((bytes / MB) * 10) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} MB`;
}
const n = (x: number) => x.toLocaleString("en-US");

export interface Usage {
  /** The board's encoded size. */
  bytes: number;
  shapes: number;
  connectors: number;
  images: number;
  /** Encoded bytes by part (estimated from each part's share of the board's JSON). */
  parts: { shapes: number; connectors: number; text: number; images: number };
  /** Largest containers and images, biggest first. */
  largest: { id: string; label: string; what: "container" | "image"; count: number; bytes: number }[];
  /** The whole document's encoded size (current state, no undo history). */
  docBytes: number;
}

const enc = new TextEncoder();
const len = (v: unknown) => (v === undefined ? 0 : enc.encode(typeof v === "string" ? v : JSON.stringify(v)).length);

/** Measures one board (see the top of the file). */
export function measureBoard(doc: Y.Doc, boardId: string): Usage {
  const m = getBoardMap(doc, boardId);
  const empty: Usage = { bytes: 0, shapes: 0, connectors: 0, images: 0, parts: { shapes: 0, connectors: 0, text: 0, images: 0 }, largest: [], docBytes: Y.encodeStateAsUpdate(doc).length };
  if (!m) return empty;
  const copy = new Y.Doc();
  copy.getMap("b").set("board", m.toJSON());
  const bytes = Y.encodeStateAsUpdate(copy).length;
  copy.destroy();
  const list = readShapes(m);
  const raw = { shapes: 0, connectors: 0, text: 0, images: 0 };
  const size = new Map<string, number>();
  let images = 0;
  for (const s of list) {
    const { text, label, props, src, alt, ...rest } = s;
    const t = len(text) + len(label) + len(props) + len(alt);
    const geo = len(rest);
    const img = s.type === "image" ? len(src) : 0;
    if (s.type === "image") images++;
    raw.text += t;
    raw.images += img;
    if (s.type === "arrow") raw.connectors += geo;
    else raw.shapes += geo;
    size.set(s.id, t + geo + img);
  }
  const total = raw.shapes + raw.connectors + raw.text + raw.images || 1;
  const k = bytes / total;
  const scale = (v: number) => Math.round(v * k);
  const boxes = list.filter((s) => s.type !== "arrow" && s.type !== "pen");
  const largest: Usage["largest"] = [];
  for (const c of boxes) {
    if (c.type === "rect" && (c.label || c.kind?.includes("container"))) {
      const [x0, y0, x1, y1] = bbox(c);
      const inside = list.filter((s) => s.id !== c.id && (() => { const [a, b, cc, d] = bbox(s); return a >= x0 && b >= y0 && cc <= x1 && d <= y1; })());
      largest.push({ id: c.id, label: `Container “${c.label || c.text || "Untitled"}”`, what: "container", count: inside.filter((s) => s.type !== "arrow").length, bytes: scale(inside.reduce((a, s) => a + (size.get(s.id) ?? 0), size.get(c.id) ?? 0)) });
    } else if (c.type === "image") largest.push({ id: c.id, label: c.alt || "Image", what: "image", count: 1, bytes: scale(size.get(c.id) ?? 0) });
  }
  largest.sort((a, b) => b.bytes - a.bytes);
  return {
    bytes,
    shapes: list.length - list.filter((s) => s.type === "arrow").length,
    connectors: list.filter((s) => s.type === "arrow").length,
    images,
    parts: { shapes: scale(raw.shapes), connectors: scale(raw.connectors), text: scale(raw.text), images: scale(raw.images) },
    largest: largest.slice(0, 5),
    docBytes: Y.encodeStateAsUpdate(doc).length,
  };
}

/** The board's usage, re-measured once edits have settled (`delay` ms after the last one). */
export function useUsage(doc: Y.Doc, boardId: string, delay = 600): Usage {
  const [u, setU] = useState(() => measureBoard(doc, boardId));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(() => setU(measureBoard(doc, boardId)), delay);
    };
    doc.on("update", on);
    on();
    return () => {
      clearTimeout(t);
      doc.off("update", on);
    };
  }, [doc, boardId, delay]);
  return u;
}

export interface BudgetUi {
  chip: React.ReactNode;
  banner: React.ReactNode;
  section: React.ReactNode;
  dialog: React.ReactNode;
}

/** Everything S9 adds to the shell: top-bar chip, banner, the Size section and the dialog. */
export function useBudget(doc: Y.Doc, boardId: string, maxDocBytes: number | undefined, select?: (ids: string[]) => void): BudgetUi {
  ensureBudgetStyles();
  const docLimit = maxDocBytes && maxDocBytes > 0 ? maxDocBytes : DEFAULT_MAX_DOC_BYTES;
  const limit = Math.floor(docLimit * BOARD_SHARE);
  const u = useUsage(doc, boardId);
  const level = levelOf(u.bytes, limit);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const pct = Math.round((u.bytes / limit) * 100);
  const of = `${mb(u.bytes)} of ${mb(limit)}`;
  const chip = level === "ok" ? null : (
    <button type="button" className={"ocdg-chip " + level} onClick={() => setOpen(true)} title="What uses space">
      <Gauge size={12} strokeWidth={SW} aria-hidden="true" />
      {`${u.bytes < MB ? mb(u.bytes) : mb(u.bytes).replace(" MB", "")} of ${mb(limit)}`}
    </button>
  );
  const banner =
    level === "over" ? (
      <div className="ocdg-ban over" role="alert">
        <Gauge size={16} strokeWidth={SW} aria-hidden="true" />
        <span className="ocdg-bt">
          <b>This diagram is over its size limit:</b> {of}. You can keep working, but the whole document stops saving at {mb(docLimit)}. Move part of it to another board, or remove what you don’t need.
        </span>
        <button type="button" className="ocdg-bb" onClick={() => setOpen(true)}>See what uses space</button>
      </div>
    ) : level === "warn" && !dismissed ? (
      <div className="ocdg-ban warn" role="status">
        <Gauge size={16} strokeWidth={SW} aria-hidden="true" />
        <span className="ocdg-bt">
          <b>This diagram is close to its size limit:</b> {of}. Large diagrams load more slowly for everyone in this document.
        </span>
        <button type="button" className="ocdg-bb" onClick={() => setOpen(true)}>See what uses space</button>
        <button type="button" className="ocdg-ib" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <X size={16} strokeWidth={SW} />
        </button>
      </div>
    ) : null;
  const section = (
    <section className="ocdg-sec" aria-labelledby="ocdg-s-size">
      <h3 className="ocdg-sh" id="ocdg-s-size">Size</h3>
      <div className="ocdg-meter-h">
        <span>{of}</span>
        <span className={"ocdg-pct " + level}>{pct}%</span>
      </div>
      <div className={"ocdg-meter " + level} role="meter" aria-label="Diagram size" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={u.bytes} aria-valuetext={`${of}, ${pct}%`}>
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <p className="ocdg-hint">
        {n(u.shapes)} shapes and {n(u.connectors)} connectors. {level === "over" ? `Over the quarter of the document’s ${mb(docLimit)} that one diagram may use.` : `A diagram can use up to a quarter of the document’s ${mb(docLimit)}.`}
      </p>
      <button type="button" className="ocdg-link" onClick={() => setOpen(true)}>See what uses space</button>
    </section>
  );
  const dialog = open ? <SpaceDialog u={u} limit={limit} docLimit={docLimit} onClose={() => setOpen(false)} select={select} /> : null;
  return { chip, banner, section, dialog };
}

function SpaceDialog({ u, limit, docLimit, onClose, select }: { u: Usage; limit: number; docLimit: number; onClose: () => void; select?: (ids: string[]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);
  useEffect(() => {
    back.current = document.activeElement;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return () => (back.current as HTMLElement | null)?.focus?.();
  }, []);
  const rows: [string, string, number][] = [
    ["Shapes", n(u.shapes), u.parts.shapes],
    ["Connectors", n(u.connectors), u.parts.connectors],
    ["Text and properties", "", u.parts.text],
    ["Images", u.images ? n(u.images) : "", u.parts.images],
  ];
  return (
    <div className="ocdg-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="ocdg-dlg ocdg-space"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocdg-space-h"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="ocdg-dh">
          <h2 id="ocdg-space-h">What uses space</h2>
          <button type="button" className="ocdg-ib" aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={SW} />
          </button>
        </div>
        <p className="ocdg-hint">{mb(u.bytes)} of {mb(limit)} for this diagram</p>
        <table className="ocdg-tbl">
          <tbody>
            {rows.map(([l, c, b]) => (
              <tr key={l}>
                <th scope="row">{l}</th>
                <td>{c}</td>
                <td>{mb(b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {u.largest.length ? (
          <>
            <h3 className="ocdg-sh">Largest parts</h3>
            <ul className="ocdg-big">
              {u.largest.map((x) => (
                <li key={x.id}>
                  <span className="ocdg-bn">
                    {x.label}
                    <span className="ocdg-hint">{x.what === "container" ? `${n(x.count)} shapes · ${mb(x.bytes)}` : `Image · ${mb(x.bytes)}`}</span>
                  </span>
                  {select ? (
                    <button type="button" className="ocdg-bb" aria-label={`Select ${x.label}`} onClick={() => (select([x.id]), onClose())}>
                      Select
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="ocdg-hint">The whole document: {mb(u.docBytes)} of {mb(docLimit)}. Undo history is not counted.</p>
      </div>
    </div>
  );
}

export const BUDGET_CSS = `
.ocdg-chip{display:inline-flex;align-items:center;gap:.25rem;height:1.5rem;padding:0 .5rem;border:0;border-radius:1rem;font-size:.6875rem;font-weight:600;margin-right:.5rem;white-space:nowrap}
.ocdg-chip.warn{background:var(--amber-bg);color:var(--amber-fg)}
.ocdg-chip.over{background:var(--red-bg);color:var(--red-fg)}
.ocdg-ban{flex:none;display:flex;align-items:center;gap:.625rem;padding:.5rem 1rem;font-size:.8125rem;border-bottom:1px solid var(--line)}
.ocdg-ban.warn{background:var(--amber-bg);color:var(--amber-fg)}
.ocdg-ban.over{background:var(--red-bg);color:var(--red-fg)}
.ocdg-bt{flex:1;min-width:0}
.ocdg-bb{height:1.75rem;padding:0 .625rem;border:1px solid var(--line-2);border-radius:.375rem;background:var(--app);color:var(--fg);font-size:.75rem;font-weight:500;white-space:nowrap}
.ocdg-bb:hover{background:var(--hover)}
.ocdg-ban .ocdg-ib{color:inherit}
.ocdg-meter-h{display:flex;justify-content:space-between;font-size:.8125rem;margin-bottom:.375rem}
.ocdg-pct{font-weight:600}
.ocdg-pct.warn{color:var(--amber-fg)}
.ocdg-pct.over{color:var(--red-fg)}
.ocdg-meter{height:.375rem;border-radius:1rem;background:var(--sunk);overflow:hidden}
.ocdg-meter span{display:block;height:100%;background:var(--accent);border-radius:inherit}
.ocdg-meter.warn span{background:var(--amber-fg)}
.ocdg-meter.over span{background:var(--red-fg)}
.ocdg-link{border:0;background:none;padding:0;margin-top:.375rem;color:var(--accent);font-size:.75rem;font-weight:500}
.ocdg-scrim{position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:rgba(0,0,0,.32);padding:1rem}
.ocdg-dlg{width:min(35rem,100%);max-height:calc(100vh - 2rem);overflow:auto;background:var(--app);color:var(--fg);border-radius:.75rem;box-shadow:var(--sh-pop);padding:1rem 1.25rem}
.ocdg-dh{display:flex;align-items:center;justify-content:space-between}
.ocdg-dh h2{font-size:1rem;font-weight:600;margin:0}
.ocdg-tbl{width:100%;border-collapse:collapse;margin:.75rem 0 1rem;font-size:.8125rem;font-variant-numeric:tabular-nums}
.ocdg-tbl th{text-align:left;font-weight:500}
.ocdg-tbl th,.ocdg-tbl td{padding:.375rem 0;border-bottom:1px solid var(--line)}
.ocdg-tbl td{text-align:right;color:var(--fg-2);padding-left:1rem}
.ocdg-big{list-style:none;margin:0 0 .75rem;padding:0}
.ocdg-big li{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.375rem 0}
.ocdg-bn{display:flex;flex-direction:column;font-size:.8125rem;min-width:0}
.ocdg-bn .ocdg-hint{margin:0}
`;

let injected = false;
function ensureBudgetStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocdg-budget", "");
  s.textContent = BUDGET_CSS;
  document.head.appendChild(s);
}
