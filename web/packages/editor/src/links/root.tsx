// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Links and backlinks in the editor (LINK-01/04/05, ADR-081), to the approved prototype
// docs/prototypes/v05-approved/links-backlinks.html: the `[[` picker and `#` block targets
// (1a), "Linked from" chips on blocks (1b), "Linked from" and unlinked mentions at the end of
// the canvas (2a) and in the side panel (2b), the hover preview (3a), link states (3b), phone
// (4a-4c), empty states (5a) and the keyboard model (6). A lazy chunk: nothing here is in the
// editor's initial JS (WEB-08 budget). Everything shown is what the server answered for this
// person; canvases they cannot open are never listed or counted.
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, CornerDownLeft, FileText, Hash, Link2, Lock, Rows3, Table2, Trash2, X } from "lucide-react";
import type { Editor, Range } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import Suggestion from "@tiptap/suggestion";
import { createStore, useStore } from "../lib/store";
import { linkInfo, linkKey, type LinkInfo } from "../editor/canvaslink";
import { api, recentCanvases, rememberCanvas, type Api, type Hit } from "./api";
import { blockKeys, linksIn, matchHostUrl, refWhere, sortGroups, visibleRefs, when, type Backlink, type Backlinks, type KindFilter, type Mention, type Preview, type Target } from "./model";
import "./links.css";

export interface LinksRootProps {
  editor: Editor;
  ticket: string;
  fileId: string;
  title: string;
  /** LINK-05: other names of this canvas (`meta.aliases`). */
  aliases?: string[];
  canEdit: boolean;
  compact: boolean;
  mentions: boolean;
  patterns: string[];
  /** The side panel is open on "Linked from". */
  side: boolean;
  setSide(open: boolean): void;
  toast(text: string, o?: { icon?: string; action?: { label: string; run(): void }; ms?: number }): void;
  /** Another canvas (the host navigates), or this one at a block. */
  open(fileId: string, blockId: string | null, newTab: boolean): void;
  scrollToBlock(blockId: string): void;
  /** The side panel's Comments tab (2b); absent when comments are off. */
  onComments?: () => void;
}

// ---------- stores shared by the plugins and the views ----------

interface PickerState {
  query: string;
  range: Range;
  rect: DOMRect | null;
  /** Chosen with `#`: the canvas whose blocks are listed. */
  canvas: Hit | null;
}
const picker = createStore<PickerState | null>(null);
let pickerKeys: ((e: KeyboardEvent) => boolean) | null = null;

interface PreviewAt {
  fileId: string;
  block: string | null;
  rect: DOMRect;
  /** A long press on a phone: a sheet. */
  sheet: boolean;
  pos: number | null;
}
const previewAt = createStore<PreviewAt | null>(null);
/** Per block key of this canvas: linking canvases the reader can open (chips). */
const chipCounts = createStore<Record<string, number>>({});
const blockFilter = createStore<string | null>(null);

const chipKey = new PluginKey("linkChips");
const keysKey = new PluginKey("linkKeys");

function nodeAt(editor: Editor, el: Element): { pos: number; attrs: Record<string, unknown> } | null {
  try {
    const pos = editor.view.posAtDOM(el, 0);
    const n = editor.state.doc.nodeAt(pos);
    return n?.type.name === "canvasLink" ? { pos, attrs: n.attrs } : null;
  } catch {
    return null;
  }
}

/** The `[[` suggestion (1a). The menu is drawn by `<Picker>`, which owns the keys. */
function pickerPlugin(editor: Editor): Plugin {
  return Suggestion({
    editor,
    pluginKey: new PluginKey("canvasLinkPicker"),
    char: "[[",
    allowSpaces: true,
    allow: ({ state, range }) => {
      const $f = state.doc.resolve(range.from);
      return !!state.schema.nodes.canvasLink && !!$f.parent.type.contentMatch.matchType(state.schema.nodes.canvasLink) && !$f.parent.type.spec.code;
    },
    items: () => [],
    render: () => ({
      onStart: (p) => picker.set({ query: p.query, range: p.range, rect: p.clientRect?.() ?? null, canvas: null }),
      onUpdate: (p) => picker.set((s) => ({ query: p.query, range: p.range, rect: p.clientRect?.() ?? null, canvas: s && p.query.includes("#") ? s.canvas : null })),
      onKeyDown: ({ event }) => (pickerKeys ? pickerKeys(event) : false),
      onExit: () => picker.set(null),
    }),
  });
}

/** Clicks, the 400 ms hover, Space and Enter on a selected link, long-press on phones, pasted
 *  host URLs (3a, 4b, 6). */
function keysPlugin(editor: Editor, p: () => LinksRootProps): Plugin {
  let hover: number | undefined;
  let press: number | undefined;
  const show = (el: Element, sheet: boolean) => {
    const n = nodeAt(editor, el);
    if (!n) return;
    previewAt.set({ fileId: String(n.attrs.fileId), block: (n.attrs.targetBlockId || n.attrs.rowId || null) as string | null, rect: el.getBoundingClientRect(), sheet, pos: n.pos });
  };
  return new Plugin({
    key: keysKey,
    props: {
      handleDOMEvents: {
        mouseover: (_v, e) => {
          const el = (e.target as Element).closest?.("a.clink");
          window.clearTimeout(hover);
          if (el) hover = window.setTimeout(() => show(el, false), 400);
          return false;
        },
        mouseout: () => {
          window.clearTimeout(hover);
          return false;
        },
        touchstart: (_v, e) => {
          const el = (e.target as Element).closest?.("a.clink");
          window.clearTimeout(press);
          if (el) press = window.setTimeout(() => show(el, true), 500);
          return false;
        },
        touchend: () => (window.clearTimeout(press), false),
        touchmove: () => (window.clearTimeout(press), false),
        click: (_v, e) => {
          const el = (e.target as Element).closest?.("a.clink");
          if (!el || previewAt.get()?.sheet) return false;
          const n = nodeAt(editor, el);
          if (!n) return false;
          e.preventDefault();
          follow(p(), n.attrs, (e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey);
          return true;
        },
      },
      handleKeyDown: (view, e) => {
        const sel = view.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "canvasLink") return false;
        if (e.key === " ") {
          const el = view.nodeDOM(sel.from) as Element | null;
          if (el) show(el, false);
          return true;
        }
        if (e.key === "Enter") {
          follow(p(), sel.node.attrs, e.metaKey || e.ctrlKey);
          return true;
        }
        return false;
      },
      handlePaste: (view, e) => {
        const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
        const hit = text && matchHostUrl(p().patterns, text);
        if (!hit || !view.state.schema.nodes.canvasLink) return false;
        const node = view.state.schema.nodes.canvasLink.create({ fileId: hit.fileId, targetBlockId: hit.blockId ?? null, label: text });
        view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
        // The label is for exports and older editors: the host's title, once known.
        void api(p().ticket)
          .resolve([{ fileId: hit.fileId, block: hit.blockId }])
          .then((r) => {
            const it = r.items[0];
            if (!it?.title || it.state !== "ok") return;
            const label = it.block ? `${it.title} › ${it.block}` : it.title;
            const { tr, doc } = editor.state;
            doc.descendants((n, pos) => {
              if (n.type.name === "canvasLink" && n.attrs.fileId === hit.fileId && n.attrs.label === text) tr.setNodeMarkup(pos, undefined, { ...n.attrs, label });
            });
            if (tr.docChanged) editor.view.dispatch(tr);
          })
          .catch(() => undefined);
        return true;
      },
    },
  });
}

function follow(p: LinksRootProps, attrs: Record<string, unknown>, newTab: boolean) {
  const fileId = String(attrs.fileId || "");
  const block = (attrs.targetBlockId || attrs.rowId || null) as string | null;
  const info = linkInfo.get().get(linkKey(fileId, block));
  if (info?.state === "none" || info?.state === "gone") {
    p.toast(info.state === "none" ? "You don't have access to this canvas" : "This canvas was deleted", { icon: info.state === "none" ? "lock" : "trash-2" });
    return;
  }
  if (fileId === p.fileId && block) return p.scrollToBlock(block);
  // A block that is gone opens the canvas at the top (3b).
  p.open(fileId, info?.state === "missing" ? null : block, newTab);
}

/** "Linked from 3" chips on headings, databases, boards and rows with backlinks (1b). */
function chipsPlugin(): Plugin {
  const build = (doc: import("@tiptap/pm/model").Node) => {
    const counts = chipCounts.get();
    if (!Object.keys(counts).length) return DecorationSet.empty;
    const decos: Decoration[] = [];
    doc.descendants((n, pos) => {
      if (!["heading", "database", "board", "spreadsheet"].includes(n.type.name)) return n.isBlock;
      const key = blockKeys(n).find((k) => counts[k]);
      if (key) {
        const at = n.type.name === "heading" ? pos + n.nodeSize - 1 : pos;
        decos.push(
          Decoration.widget(at, () => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "lk-chip";
            b.contentEditable = "false";
            b.dataset.block = key;
            b.setAttribute("aria-label", `Linked from ${counts[key]} canvas${counts[key] === 1 ? "" : "es"}`);
            b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8"/></svg><span>${counts[key]}</span>`;
            return b;
          }, { side: 1, key: `lk-${key}-${counts[key]}`, ignoreSelection: true }),
        );
      }
      return n.type.name !== "heading";
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin({
    key: chipKey,
    state: {
      init: (_, s) => build(s.doc),
      apply: (tr, old, _o, s) => (tr.getMeta(chipKey) || tr.docChanged ? build(s.doc) : old),
    },
    props: { decorations: (s) => chipKey.getState(s) },
  });
}

// ---------- the `[[` picker (1a, 4c) ----------

type Row = { kind: "canvas"; hit: Hit; group: string } | { kind: "target"; t: Target };

function Picker({ editor, a, compact, fileId, title }: { editor: Editor; a: Api; compact: boolean; fileId: string; title: string }) {
  const st = useStore(picker);
  const [hits, setHits] = useState<Hit[]>([]);
  const [targets, setTargets] = useState<{ fileId: string; items: Target[] } | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = st?.query ?? "";
  const hashAt = q.indexOf("#");
  const canvasQ = (hashAt >= 0 ? q.slice(0, hashAt) : q).trim();
  const blockQ = hashAt >= 0 ? q.slice(hashAt + 1) : "";
  const chosen = st?.canvas ?? null;

  useEffect(() => {
    if (!st || chosen) return;
    let off = false;
    const t = window.setTimeout(() => {
      if (!canvasQ) return setHits([]);
      a.search(canvasQ)
        .then((r) => {
          if (off) return;
          const seen = new Set<string>();
          setHits(r.items.filter((h) => h.fileId !== fileId && !seen.has(h.fileId) && seen.add(h.fileId)));
        })
        .catch(() => !off && setHits([]));
    }, 180);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
  }, [canvasQ, !!st, chosen, a, fileId]);

  useEffect(() => {
    if (!chosen) return setTargets(null);
    let off = false;
    const id = chosen.fileId === fileId ? fileId : chosen.fileId;
    a.targets(id)
      .then((r) => !off && setTargets({ fileId: id, items: r.items }))
      .catch(() => !off && setTargets({ fileId: id, items: [] }));
    return () => void (off = true);
  }, [chosen?.fileId, a, fileId]);

  const rows: Row[] = useMemo(() => {
    if (chosen && targets) {
      const f = blockQ.replace(/^\^/, "").toLowerCase();
      const onlyBlocks = blockQ.startsWith("^");
      return targets.items
        .filter((t) => (onlyBlocks ? t.kind !== "heading" && t.kind !== "database" && t.kind !== "row" : t.kind === "heading" || t.kind === "database" || t.kind === "row"))
        .filter((t) => !f || t.text.toLowerCase().includes(f))
        .slice(0, 12)
        .map((t) => ({ kind: "target", t }));
    }
    const lower = canvasQ.toLowerCase();
    const rec = recentCanvases().filter((h) => h.fileId !== fileId && (!lower || h.title.toLowerCase().includes(lower)));
    const out: Row[] = [];
    const seen = new Set<string>();
    hits.forEach((h, i) => {
      if (seen.has(h.fileId)) return;
      seen.add(h.fileId);
      out.push({ kind: "canvas", hit: h, group: i === 0 ? "Best match" : "Other canvases" });
    });
    rec.forEach((h) => !seen.has(h.fileId) && (seen.add(h.fileId), out.push({ kind: "canvas", hit: h, group: "Recent" })));
    // This canvas's own headings: `[[#` links a block here.
    if (!canvasQ && hashAt < 0) out.push({ kind: "canvas", hit: { fileId, title }, group: "This canvas" });
    return out.slice(0, 10);
  }, [chosen, targets, blockQ, canvasQ, hits, fileId, title, hashAt]);

  useEffect(() => setSel(0), [rows.length, chosen?.fileId]);

  const insert = useCallback(
    (row: Row | undefined) => {
      if (!st || !row) return;
      let attrs: Record<string, unknown>;
      if (row.kind === "canvas") {
        rememberCanvas(row.hit);
        attrs = { fileId: row.hit.fileId, label: row.hit.title };
      } else {
        const c = st.canvas!;
        attrs = { fileId: c.fileId, label: `${c.title} › ${row.t.text}`, ...(row.t.kind === "row" ? { rowId: row.t.id, targetBlockId: row.t.db ?? null } : { targetBlockId: row.t.id }) };
      }
      editor.chain().focus().insertContentAt(st.range, [{ type: "canvasLink", attrs }, { type: "text", text: " " }]).run();
      picker.set(null);
    },
    [editor, st],
  );

  pickerKeys = (e) => {
    if (!st) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setSel((s) => (rows.length ? (s + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length : 0));
      return true;
    }
    if (e.key === "Escape") {
      picker.set(null);
      return true;
    }
    if (e.key === "Enter" && e.shiftKey) {
      // Plain text: keep what was typed.
      picker.set(null);
      return false;
    }
    if (e.key === "Enter") {
      insert(rows[sel]);
      return true;
    }
    if (e.key === "#" && !chosen && rows[sel]?.kind === "canvas") {
      const hit = (rows[sel] as { hit: Hit }).hit;
      editor.chain().insertContentAt(st.range, `[[${hit.title}#`).run();
      picker.set((s) => (s ? { ...s, canvas: hit } : s));
      return true;
    }
    if (e.key === "Tab") return true;
    return false;
  };

  if (!st) return null;
  const r = st.rect;
  const style: React.CSSProperties = compact || !r ? {} : { left: Math.max(8, Math.min(r.left, window.innerWidth - 400)), top: r.bottom + 6 };
  let lastGroup = "";
  return (
    <div className={`lk-pick${compact ? " sheet" : ""}`} style={style} role="dialog" aria-label={chosen ? `Blocks in ${chosen.title}` : "Link a canvas"} onMouseDown={(e) => e.preventDefault()}>
      <div className="lk-pick-h">
        {chosen ? (
          <>
            <FileText size={14} aria-hidden="true" /> <b>{chosen.title}</b> <Hash size={13} aria-hidden="true" />
          </>
        ) : (
          <>
            <span>Canvases matching “{canvasQ || "…"}”</span>
          </>
        )}
        <span className="lk-grow" />
        <kbd>Esc</kbd>
      </div>
      <div className="lk-pick-b" ref={listRef} role="listbox" aria-label={chosen ? "Headings, databases and rows" : "Canvases"}>
        {rows.length === 0 ? <div className="lk-pick-empty">{chosen ? (targets ? "No heading or database matches" : "Loading…") : canvasQ ? "No canvas you can open matches" : "Type a canvas title"}</div> : null}
        {rows.map((row, i) => {
          const g = row.kind === "canvas" ? row.group : row.t.kind === "heading" ? "Headings" : row.t.kind === "database" || row.t.kind === "row" ? "Databases and rows" : "Blocks";
          const head = g !== lastGroup ? <div className="lk-cap" key={`g-${g}`}>{g}</div> : null;
          lastGroup = g;
          return (
            <div key={row.kind === "canvas" ? `c-${row.hit.fileId}` : `t-${row.t.id}`}>
              {head}
              <div role="option" aria-selected={i === sel} className={`lk-opt${i === sel ? " on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => insert(row)}>
                {row.kind === "canvas" ? (
                  <>
                    <FileText size={15} aria-hidden="true" />
                    <span className="lk-opt-t">
                      <span className="lk-opt-n">{row.hit.title}</span>
                      <span className="lk-opt-s">{[row.hit.path, row.hit.updatedAt ? `edited ${when(row.hit.updatedAt)}` : ""].filter(Boolean).join(" · ")}</span>
                    </span>
                  </>
                ) : (
                  <>
                    {row.t.kind === "heading" ? <Hash size={15} aria-hidden="true" /> : row.t.kind === "row" ? <Rows3 size={15} aria-hidden="true" /> : row.t.kind === "database" ? <Table2 size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
                    <span className="lk-opt-t">
                      <span className="lk-opt-n">{row.t.text}</span>
                      {row.t.kind === "row" ? <span className="lk-opt-s">Row</span> : null}
                    </span>
                  </>
                )}
                {i === sel ? <CornerDownLeft size={14} className="lk-ent" aria-hidden="true" /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="lk-pick-f">
        {chosen ? (
          <span>
            <kbd>#^</kbd> any block by its first words
          </span>
        ) : (
          <>
            <span>
              <kbd>#</kbd> link a heading or database
            </span>
            <span>
              <kbd>⇧↵</kbd> plain text
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- hover preview (3a, 3b, 4b) ----------

function PreviewCard({ a, p, editor }: { a: Api; p: LinksRootProps; editor: Editor }) {
  const at = useStore(previewAt);
  const [pv, setPv] = useState<Preview | null>(null);
  const inside = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return setPv(null);
    let off = false;
    setPv(null);
    a.preview(at.fileId, at.block)
      .then((v) => !off && setPv(v))
      .catch(() => !off && setPv({ fileId: at.fileId, state: "none" }));
    return () => void (off = true);
  }, [at?.fileId, at?.block, a]);
  useEffect(() => {
    if (!at) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && (previewAt.set(null), editor.commands.focus());
    const out = (e: MouseEvent) => {
      if (at.sheet) return;
      const t = e.target as Element;
      if (card.current?.contains(t) || t.closest?.("a.clink")) return;
      window.setTimeout(() => !inside.current && previewAt.set(null), 200);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mouseover", out);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mouseover", out);
    };
  }, [at, editor]);
  if (!at) return null;
  const style: React.CSSProperties = at.sheet ? {} : { left: Math.max(8, Math.min(at.rect.left, window.innerWidth - 380)), top: Math.min(at.rect.bottom + 8, window.innerHeight - 260) };
  const close = () => previewAt.set(null);
  const remove = () => {
    if (at.pos == null) return;
    const n = editor.state.doc.nodeAt(at.pos);
    if (n?.type.name === "canvasLink") editor.chain().focus().deleteRange({ from: at.pos, to: at.pos + n.nodeSize }).run();
    close();
  };
  const st = pv?.state;
  return (
    <>
      {at.sheet ? <div className="lk-scrim" onClick={close} /> : null}
      <div ref={card} className={`lk-pv${at.sheet ? " sheet" : ""}`} style={style} role="dialog" aria-label="Link preview" onMouseEnter={() => (inside.current = true)} onMouseLeave={() => ((inside.current = false), !at.sheet && close())}>
        {!pv ? (
          <div className="lk-pv-load" aria-busy="true">
            Loading…
          </div>
        ) : st === "none" ? (
          <div className="lk-pv-state">
            <Lock size={16} aria-hidden="true" /> You don't have access to this canvas.
          </div>
        ) : st === "gone" ? (
          <div className="lk-pv-state">
            <Trash2 size={16} aria-hidden="true" /> This canvas was deleted.
            {p.canEdit ? (
              <button type="button" className="lk-btn" onClick={remove}>
                Remove link
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="lk-pv-h">
              <FileText size={16} aria-hidden="true" />
              <div className="lk-pv-t">
                <b>
                  {pv.title}
                  {pv.block ? <span className="lk-pv-b"> › {pv.block}</span> : null}
                </b>
                <span>{[pv.path, pv.updatedAt ? `edited ${when(pv.updatedAt)}${pv.updatedBy ? ` by ${pv.updatedBy}` : ""}` : ""].filter(Boolean).join(" · ")}</span>
              </div>
            </div>
            {st === "missing" ? <p className="lk-pv-miss">This block was deleted or moved. Opening shows the canvas from the top.</p> : null}
            <div className="lk-pv-body">
              {(pv.lines ?? []).map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
            <div className="lk-pv-f">
              <button type="button" className="lk-btn pri" onClick={() => (close(), p.open(at.fileId, st === "missing" ? null : at.block, false))}>
                Open
              </button>
              <button type="button" className="lk-btn" onClick={() => (close(), p.open(at.fileId, st === "missing" ? null : at.block, true))}>
                <ArrowUpRight size={14} aria-hidden="true" /> Open beside
              </button>
              {at.sheet ? (
                <button type="button" className="lk-btn" onClick={() => void navigator.clipboard?.writeText(hostUrl(p.patterns, at.fileId, at.block)).then(() => p.toast("Link copied", { icon: "link" }))}>
                  <Link2 size={14} aria-hidden="true" /> Copy link
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function hostUrl(patterns: string[], fileId: string, block: string | null): string {
  const t = patterns.find((x) => (block ? x.includes("{blockId}") : !x.includes("{blockId}"))) ?? patterns[0] ?? "";
  return t.replace("{fileId}", encodeURIComponent(fileId)).replace("{blockId}", encodeURIComponent(block ?? ""));
}

// ---------- Linked from (2a, 2b, 4a, 5a) and unlinked mentions (2a, 5b) ----------

function blockNames(editor: Editor): Map<string, string> {
  const m = new Map<string, string>();
  editor.state.doc.descendants((n) => {
    for (const k of blockKeys(n)) if (!m.has(k)) m.set(k, n.textContent.trim().slice(0, 60) || n.type.name);
    return true;
  });
  return m;
}

function Excerpt({ r }: { r: Backlink["refs"][number] }) {
  if (!r.excerpt) return null;
  return (
    <p className="lk-ex">
      {r.excerpt.before}
      {r.excerpt.link ? <span className="lk-ex-l">{r.excerpt.link}</span> : null}
      {r.excerpt.after}
    </p>
  );
}

interface ListProps {
  data: Backlinks | null;
  error: boolean;
  p: LinksRootProps;
  names: Map<string, string>;
  inSide: boolean;
  onMore(): void;
}

function BacklinkList({ data, error, p, names, inSide, onMore }: ListProps) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [sort, setSort] = useState<"recent" | "title">("recent");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const block = useStore(blockFilter);
  const blockSel = inSide ? block : null;
  if (error) return <p className="lk-note">Linked from could not be loaded. It will try again when the canvas is saved.</p>;
  if (!data) return <p className="lk-note" aria-busy="true">Loading…</p>;
  const groups = sortGroups(data.items, sort)
    .map((b) => ({ b, refs: visibleRefs(b, kind, blockSel) }))
    .filter((g) => g.refs.length);
  if (!data.items.length)
    return (
      <div className="lk-empty">
        <p>
          No canvas you can open links here yet. Type <kbd>[[</kbd> in another canvas to link this one, or copy a link to any block.
        </p>
        {p.patterns.length ? (
          <button type="button" className="lk-btn" onClick={() => void navigator.clipboard?.writeText(hostUrl(p.patterns, p.fileId, null)).then(() => p.toast("Link copied", { icon: "link" }))}>
            <Link2 size={14} aria-hidden="true" /> Copy link to this canvas
          </button>
        ) : null}
      </div>
    );
  const blocks = Object.keys(data.blocks);
  return (
    <>
      <div className="lk-filters" role="group" aria-label="Filter">
        {(["all", "link", "embed", "relation"] as KindFilter[]).map((k) => (
          <button key={k} type="button" className={`lk-f${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === "all" ? "All" : k === "link" ? "Links" : k === "embed" ? "Live blocks" : "Relations"}
          </button>
        ))}
        <span className="lk-grow" />
        {inSide ? null : blocks.length ? (
          <select className="lk-sel" aria-label="Block" value={block ?? ""} onChange={(e) => blockFilter.set(e.target.value || null)}>
            <option value="">Any block</option>
            {blocks.map((b) => (
              <option key={b} value={b}>
                {names.get(b) ?? b}
              </option>
            ))}
          </select>
        ) : null}
        <select className="lk-sel" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as "recent" | "title")}>
          <option value="recent">Recent</option>
          <option value="title">Title</option>
        </select>
      </div>
      <ul className="lk-groups">
        {groups.map(({ b, refs }) => {
          const open = !folded.has(b.fileId);
          const id = `lk-g-${b.fileId}`;
          return (
            <li key={b.fileId} className="lk-g">
              <button
                type="button"
                className="lk-gh"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setFolded((f) => {
                  const n = new Set(f);
                  if (n.has(b.fileId)) n.delete(b.fileId);
                  else n.add(b.fileId);
                  return n;
                })}
              >
                {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                <FileText size={15} aria-hidden="true" />
                <span className="lk-gt">{b.title}</span>
                {refs.length > 1 ? <span className="lk-gc">{refs.length} links</span> : null}
                <span className="lk-grow" />
                <span className="lk-gw">{when(b.updatedAt ?? b.savedAt)}</span>
              </button>
              {open ? (
                <ul id={id} className="lk-refs">
                  {refs.map((r, i) => (
                    <li key={i}>
                      <a
                        href="#"
                        className="lk-ref"
                        onClick={(e) => {
                          e.preventDefault();
                          p.open(b.fileId, r.block || null, e.metaKey || e.ctrlKey);
                        }}
                      >
                        <span className="lk-rw">{refWhere(r, (k) => names.get(k)) || b.path || ""}</span>
                        <Excerpt r={r} />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {groups.length === 0 ? <p className="lk-note">Nothing matches these filters.</p> : null}
      {data.next ? (
        <button type="button" className="lk-btn" onClick={onMore}>
          Show more
        </button>
      ) : null}
      <p className="lk-note">Shows only canvases you can open. Updated when a canvas is saved.</p>
    </>
  );
}

function Mentions({ a, p }: { a: Api; p: LinksRootProps }) {
  const [items, setItems] = useState<Mention[] | null>(null);
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const live = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let off = false;
    a.mentions([p.title, ...(p.aliases ?? [])])
      .then((r) => !off && setItems(r.available ? r.items : []))
      .catch(() => !off && setItems([]));
    return () => void (off = true);
  }, [a, p.title, (p.aliases ?? []).join("|")]);
  useEffect(() => setOpen((o) => o || (items !== null && items.length > 0 && items.length <= 5)), [items]);
  if (!items || !items.length) return null;
  const say = (t: string) => live.current && (live.current.textContent = t);
  const link = async (m: Mention, quiet = false) => {
    try {
      const done = await a.link(m);
      setItems((l) => (l ?? []).filter((x) => x.fileId !== m.fileId));
      say(`Linked in ${m.title}`);
      if (!quiet)
        p.toast(`Linked in ${m.title}`, {
          icon: "link",
          ms: 8000,
          action: {
            label: "Undo",
            run: () =>
              void a
                .unlink(done.fileId, done.blockId)
                .then(() => (setItems((l) => [...(l ?? []), m]), say(`Link in ${m.title} undone`)))
                .catch(() => p.toast("Could not undo: the block changed since", { icon: "triangle-alert" })),
          },
        });
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      setRefused((r) => ({ ...r, [m.fileId]: status === 403 ? "You can't edit that canvas" : "The mention is not there any more" }));
      return false;
    }
  };
  const linkAll = async () => {
    let n = 0;
    for (const m of items) if (!refused[m.fileId] && (await link(m, true))) n++;
    p.toast(n ? `Linked in ${n} canvas${n === 1 ? "" : "es"}` : "Nothing linked: you can't edit those canvases", { icon: "link" });
  };
  return (
    <section className="lk-men" aria-labelledby="lk-men-h">
      <div className="lk-sh">
        <button type="button" id="lk-men-h" className="lk-sh-b" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} Unlinked mentions <span className="lk-count">{items.length}</span>
        </button>
        <span className="lk-grow" />
        {open && p.canEdit ? (
          <button type="button" className="lk-btn" onClick={() => void linkAll()}>
            Link all
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="lk-groups">
          {items.map((m) => (
            <li key={m.fileId} className="lk-g lk-mi">
              <div className="lk-mi-t">
                <FileText size={15} aria-hidden="true" />
                <span className="lk-gt">{m.title}</span>
                <span className="lk-grow" />
                {refused[m.fileId] ? (
                  <span className="lk-cant" title={refused[m.fileId]}>
                    Can't edit
                  </span>
                ) : (
                  <button type="button" className="lk-btn" aria-label={`Link the mention in ${m.title}`} onClick={() => void link(m)}>
                    Link
                  </button>
                )}
              </div>
              {m.snippet ? <p className="lk-ex">{m.snippet}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <span ref={live} className="lk-sr" aria-live="polite" />
    </section>
  );
}

function useBacklinks(a: Api, block: string | null, enabled = true) {
  const [data, setData] = useState<Backlinks | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    a.backlinks({ block })
      .then((d) => {
        if (off) return;
        setData(d);
        setError(false);
        if (!block) {
          chipCounts.set(d.blocks);
        }
      })
      .catch(() => !off && setError(true));
    return () => void (off = true);
  }, [a, block, tick, enabled]);
  const more = () => {
    if (!data?.next) return;
    void a.backlinks({ block, cursor: data.next }).then((d) => setData((o) => (o ? { ...d, items: [...o.items, ...d.items] } : d)));
  };
  return { data, error, more, reload: () => setTick((t) => t + 1) };
}

export default function LinksRoot(p: LinksRootProps) {
  const { editor } = p;
  const a = useMemo(() => api(p.ticket), [p.ticket]);
  const pRef = useRef(p);
  pRef.current = p;
  const block = useStore(blockFilter);
  const all = useBacklinks(a, null);
  const side = useBacklinks(a, block, p.side);
  const [names, setNames] = useState(() => blockNames(editor));

  // Plugins: the picker first (its keys win in an open menu), then keys and chips.
  useEffect(() => {
    if (editor.isDestroyed) return;
    const plugins = [pickerPlugin(editor), keysPlugin(editor, () => pRef.current), chipsPlugin()];
    editor.registerPlugin(plugins[0], (_, list) => [plugins[0], ...list.filter((x) => x !== plugins[0])]);
    editor.registerPlugin(plugins[1]);
    editor.registerPlugin(plugins[2]);
    const redraw = chipCounts.subscribe(() => !editor.isDestroyed && editor.view.dispatch(editor.state.tr.setMeta(chipKey, true)));
    return () => {
      redraw();
      if (editor.isDestroyed) return;
      editor.unregisterPlugin("canvasLinkPicker");
      editor.unregisterPlugin(keysKey);
      editor.unregisterPlugin(chipKey);
    };
  }, [editor]);

  // Titles and states of the links in this canvas (3b): asked once per target, again on change.
  useEffect(() => {
    let t: number | undefined;
    const asked = new Set<string>();
    const run = () => {
      const want = linksIn(editor.state.doc as never).filter((x) => !asked.has(linkKey(x.fileId, x.block)));
      if (!want.length) return;
      want.forEach((x) => asked.add(linkKey(x.fileId, x.block)));
      for (let i = 0; i < want.length; i += 100)
        void a
          .resolve(want.slice(i, i + 100))
          .then((r) => {
            const m = new Map(linkInfo.get());
            for (const it of r.items) m.set(linkKey(it.fileId, it.blockId), { state: it.state, title: it.title, block: it.block } as LinkInfo);
            linkInfo.set(m);
          })
          .catch(() => want.forEach((x) => asked.delete(linkKey(x.fileId, x.block))));
    };
    run();
    const on = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => (run(), setNames(blockNames(editor))), 600);
    };
    editor.on("transaction", on);
    return () => {
      editor.off("transaction", on);
      window.clearTimeout(t);
    };
  }, [editor, a]);

  // Chip clicks open the side panel on that block (1b → 2b).
  useEffect(() => {
    const click = (e: MouseEvent) => {
      const b = (e.target as Element).closest?.(".lk-chip") as HTMLElement | null;
      if (!b) return;
      e.preventDefault();
      blockFilter.set(b.dataset.block ?? null);
      p.setSide(true);
    };
    const dom = editor.view.dom;
    dom.addEventListener("click", click);
    return () => dom.removeEventListener("click", click);
  }, [editor, p.setSide]);

  // The end-of-canvas section lives right after the editor's content (2a, 4a).
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "lk-endhost";
    editor.view.dom.after(el);
    setHost(el);
    return () => el.remove();
  }, [editor]);

  const total = all.data?.total ?? 0;
  const end = host
    ? createPortal(
        <section className={`lk-end${p.compact ? " compact" : ""}`} aria-labelledby="lk-end-h">
          <div className="lk-sh">
            <h2 id="lk-end-h">Linked from</h2>
            {all.data && total ? <span className="lk-count">{p.compact ? total : `${total} canvas${total === 1 ? "" : "es"}`}</span> : null}
          </div>
          <BacklinkList data={all.data} error={all.error} p={p} names={names} inSide={false} onMore={all.more} />
          {p.mentions ? <Mentions a={a} p={p} /> : null}
        </section>,
        host,
      )
    : null;

  const sideName = block ? names.get(block) ?? block : null;
  return (
    <>
      {end}
      <Picker editor={editor} a={a} compact={p.compact} fileId={p.fileId} title={p.title} />
      <PreviewCard a={a} p={p} editor={editor} />
      {p.side ? (
        <aside className={`side lk-side${p.compact ? " sheet" : ""}`} aria-label="Linked from">
          <div className="shd">
            <b>Linked from</b>
            {side.data ? <span className="lk-count">{side.data.total}</span> : null}
            <span className="grow" />
            <button type="button" className="lk-x" aria-label="Close" onClick={() => (p.setSide(false), blockFilter.set(null))}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          {p.onComments ? (
            <div className="stabs" role="tablist" aria-label="Side panel">
              <button type="button" role="tab" aria-selected="false" className="stab" onClick={p.onComments}>
                Comments
              </button>
              <button type="button" role="tab" aria-selected="true" className="stab on">
                Linked from
              </button>
            </div>
          ) : null}
          <div className="sbd">
            {sideName ? (
              <div className="lk-fchip">
                <Hash size={13} aria-hidden="true" /> {sideName}
                <button type="button" aria-label="Show links to the whole canvas" onClick={() => blockFilter.set(null)}>
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <BacklinkList data={side.data} error={side.error} p={p} names={names} inSide={true} onMore={side.more} />
          </div>
        </aside>
      ) : null}
    </>
  );
}
