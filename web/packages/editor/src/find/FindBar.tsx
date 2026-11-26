// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The find bar (SRCH-01, approved prototype docs/prototypes/v03-approved/search.html frames
// 1a-1h, 4a, 5a-5b). Loaded only when someone opens it (the editor's initial JS budget).
// Desktop: floating at the top right of the document column. Phone (< 45em): it replaces the
// top bar, with Up, Down, Replace and Options in a bar above the keyboard.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { ArrowDown, ArrowUp, CaseSensitive, ChevronRight, Regex, Replace, ReplaceAll, Search, SlidersHorizontal, TriangleAlert, WholeWord, X } from "lucide-react";
import { compile, counter, DEFAULT_OPTIONS, findAll, keepCurrent, replaceable, replaceMatches, TooSlow, where, type Match, type Options } from "./engine";
import { findPlugin, findKey, setMarks } from "./plugin";
import "./find.css";

const STORE = "oc:find";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MAX_TICKS = 400;

function loadOptions(): Options {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "null") as Partial<Options> | null;
    if (v) return { ...DEFAULT_OPTIONS, ...v, scope: { ...DEFAULT_OPTIONS.scope, ...(v.scope ?? {}) } };
  } catch {
    /* private mode */
  }
  return DEFAULT_OPTIONS;
}
function saveOptions(o: Options) {
  try {
    localStorage.setItem(STORE, JSON.stringify(o));
  } catch {
    /* private mode */
  }
}

export interface FindBarProps {
  editor: Editor;
  doc: Y.Doc;
  /** Editors replace; viewers and commenters find only (frame 1h). */
  canReplace: boolean;
  /** Phone layout. */
  compact: boolean;
  /** The text to start with (the selection, or a search result's query). */
  initial: string;
  /** Open with the replace row (⌘⌥F / Ctrl+H). */
  replace: boolean;
  /** Bumped to re-focus the field when ⌘F is pressed again. */
  focusTick: number;
  scrollEl: HTMLElement | null;
  toast(text: string, opts?: { icon?: string; action?: { label: string; run: () => void } }): void;
  onClose(): void;
}

type State =
  | { kind: "idle" }
  | { kind: "ok"; matches: Match[]; capped: boolean }
  | { kind: "invalid"; error: string }
  | { kind: "slow" };

export function FindBar(p: FindBarProps) {
  const { editor, doc } = p;
  const [q, setQ] = useState(p.initial);
  const [rep, setRep] = useState("");
  const [opts, setOpts] = useState<Options>(loadOptions);
  const [showReplace, setShowReplace] = useState(p.replace && p.canReplace);
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [st, setSt] = useState<State>({ kind: "idle" });
  const [cur, setCur] = useState(-1);
  const [ticks, setTicks] = useState<{ top: number; cur: boolean }[]>([]);
  const [live, setLive] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const repField = useRef<HTMLInputElement>(null);
  const curRef = useRef<Match | null>(null);
  const announced = useRef(0);

  useEffect(() => saveOptions(opts), [opts]);
  useEffect(() => {
    if (p.replace && p.canReplace) setShowReplace(true);
  }, [p.replace, p.canReplace, p.focusTick]);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [p.focusTick]);

  // The decoration plugin lives on the editor only while the bar is open.
  useEffect(() => {
    if (!findKey.getState(editor.state)) editor.registerPlugin(findPlugin());
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(findKey);
      clearDom();
    };
  }, [editor]);

  const compiled = useMemo(() => compile(q, opts), [q, opts]);

  // Recompute on the query, the options and every change to the canvas (others typing too).
  const recompute = useCallback(() => {
    if (editor.isDestroyed) return;
    if (!q) {
      setSt({ kind: "idle" });
      setCur(-1);
      curRef.current = null;
      return;
    }
    if (!compiled.ok) {
      setSt({ kind: "invalid", error: compiled.error });
      setCur(-1);
      curRef.current = null;
      return;
    }
    try {
      const r = findAll(editor.state.doc, doc, compiled.re, opts.scope);
      const i = keepCurrent(curRef.current, r.matches);
      curRef.current = i >= 0 ? r.matches[i] : null;
      setSt({ kind: "ok", matches: r.matches, capped: r.capped });
      setCur(i);
    } catch (e) {
      if (!(e instanceof TooSlow)) throw e;
      setSt({ kind: "slow" });
      setCur(-1);
      curRef.current = null;
    }
  }, [editor, doc, q, compiled, opts.scope]);
  useEffect(() => {
    recompute();
  }, [recompute]);
  useEffect(() => {
    let raf = 0;
    const later = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    const onTr = ({ transaction }: { transaction: { docChanged: boolean } }) => transaction.docChanged && later();
    editor.on("transaction", onTr);
    doc.on("update", later);
    return () => {
      cancelAnimationFrame(raf);
      editor.off("transaction", onTr);
      doc.off("update", later);
    };
  }, [editor, doc, recompute]);

  const matches = st.kind === "ok" ? st.matches : [];
  const current = cur >= 0 ? matches[cur] ?? null : null;

  // Decorations, DOM marks for cells and shapes, the scrollbar ticks.
  useEffect(() => {
    const ranges: { from: number; to: number }[] = [];
    let ci = -1;
    matches.forEach((m, i) => {
      if (m.kind !== "text") return;
      if (i === cur) ci = ranges.length;
      ranges.push({ from: m.from, to: m.to });
    });
    setMarks(editor, { ranges, current: ci });
    markDom(matches, cur);
    setTicks(tickPositions(editor, matches, cur, p.scrollEl));
  }, [editor, matches, cur, p.scrollEl]);

  // The counter is a polite live region, announced at most once a second.
  const count = st.kind === "invalid" ? "Invalid pattern" : st.kind === "slow" ? "Pattern too slow" : q ? counter(cur, matches.length, st.kind === "ok" && st.capped) : "";
  useEffect(() => {
    const now = Date.now();
    const wait = Math.max(0, 1000 - (now - announced.current));
    const t = window.setTimeout(() => {
      announced.current = Date.now();
      setLive(count);
    }, wait);
    return () => window.clearTimeout(t);
  }, [count]);

  const go = useCallback(
    (dir: 1 | -1) => {
      if (!matches.length) return;
      const i = cur < 0 ? 0 : (cur + dir + matches.length) % matches.length;
      curRef.current = matches[i];
      setCur(i);
      reveal(editor, matches[i], p.scrollEl);
    },
    [matches, cur, editor, p.scrollEl],
  );
  // Reveal the current match when it changes through typing in the field.
  useEffect(() => {
    if (current) reveal(editor, current, p.scrollEl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, opts]);

  const um = () => yUndoPluginKey.getState(editor.state)?.undoManager ?? null;
  const replaceOne = () => {
    if (!p.canReplace || !current) return;
    if (!replaceable(current)) {
      p.toast(current.kind === "live" ? "Matches in a live block are replaced in its own canvas" : "This match can't be replaced here", { icon: "info" });
      return go(1);
    }
    replaceMatches(editor, doc, [current], rep, opts.regex, um());
  };
  const replaceAll = () => {
    if (!p.canReplace || !matches.length) return;
    const targets = matches.filter((m) => m.kind !== "live" && m.kind !== "comment");
    const liveN = matches.filter((m) => m.kind === "live").length;
    const sum = replaceMatches(editor, doc, targets, rep, opts.regex, um());
    const extra = [sum.skipped ? `${sum.skipped} read-only ${sum.skipped === 1 ? "cell" : "cells"} skipped` : "", liveN ? `${liveN} more in live blocks` : ""].filter(Boolean).join(" · ");
    p.toast(`Replaced ${sum.replaced} “${q}” with “${rep}”${extra ? ` · ${extra}` : ""}`, {
      icon: "check",
      action: { label: "Undo", run: () => um()?.undo() },
    });
  };

  const close = () => {
    // Esc puts the caret on the current match, selected, so typing replaces it.
    if (current?.kind === "text" && !editor.isDestroyed) editor.chain().setTextSelection({ from: current.from, to: current.to }).focus().run();
    else if (!editor.isDestroyed) editor.commands.focus();
    p.onClose();
  };
  const toggle = (k: "caseSensitive" | "wholeWord" | "regex") => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const keyField = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      return close();
    }
    if (e.key === "Enter" || e.key === "F3" || (mod && (e.key === "g" || e.key === "G"))) {
      e.preventDefault();
      return go(e.shiftKey ? -1 : 1);
    }
    if (e.altKey && !mod) {
      const k = e.code === "KeyC" ? "caseSensitive" : e.code === "KeyW" ? "wholeWord" : e.code === "KeyR" ? "regex" : null;
      if (k) {
        e.preventDefault();
        toggle(k);
      }
    }
  };
  const keyReplace = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      return close();
    }
    if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey && e.altKey)) {
      e.preventDefault();
      return replaceAll();
    }
    if (e.key === "Enter" && !mod) {
      e.preventDefault();
      return replaceOne();
    }
    keyField(e);
  };

  const bad = st.kind === "invalid" || st.kind === "slow" || (st.kind === "ok" && q && !matches.length);
  const sub = where(current);
  const caseBtn = <button type="button" className={"fb-o" + (opts.caseSensitive ? " on" : "")} aria-pressed={opts.caseSensitive} title={`Match case (${isMac ? "⌥C" : "Alt+C"})`} aria-label="Match case" onClick={() => toggle("caseSensitive")}><CaseSensitive size={15} aria-hidden="true" /></button>;
  const wordBtn = <button type="button" className={"fb-o" + (opts.wholeWord ? " on" : "")} aria-pressed={opts.wholeWord} title={`Whole word (${isMac ? "⌥W" : "Alt+W"})`} aria-label="Whole word" onClick={() => toggle("wholeWord")}><WholeWord size={15} aria-hidden="true" /></button>;
  const regexBtn = <button type="button" className={"fb-o" + (opts.regex ? " on" : "")} aria-pressed={opts.regex} title={`Use a pattern (${isMac ? "⌥R" : "Alt+R"})`} aria-label="Use a pattern (regular expression)" onClick={() => toggle("regex")}><Regex size={15} aria-hidden="true" /></button>;
  const input = (
    <input
      ref={field}
      className="fb-field"
      type="search"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onKeyDown={keyField}
      placeholder="Find in canvas"
      aria-label="Find in canvas"
      aria-invalid={bad ? true : undefined}
      aria-describedby="oc-find-count"
      spellCheck={false}
      autoComplete="off"
    />
  );
  const errorLine =
    st.kind === "invalid" ? (
      <div className="fb-err" role="alert"><TriangleAlert size={14} aria-hidden="true" /><span>{st.error || "Invalid pattern"}: <code>{q}</code></span></div>
    ) : st.kind === "slow" ? (
      <div className="fb-err" role="alert"><TriangleAlert size={14} aria-hidden="true" /><span>Pattern too slow. Try a simpler one.</span></div>
    ) : null;
  const scopeItems = (
    <>
      <div className="fb-mh">Search in</div>
      {([["text", "Text"], ["cells", "Database cells"], ["board", "Board text"], ["comments", "Comments (find only)"]] as const).map(([k, label]) => (
        <label key={k} className="fb-mi">
          <input type="checkbox" checked={opts.scope[k]} onChange={() => setOpts((o) => ({ ...o, scope: { ...o.scope, [k]: !o.scope[k] } }))} />
          {label}
        </label>
      ))}
    </>
  );
  const ticksEl = ticks.length ? (
    <div className="fb-ticks" aria-hidden="true" style={p.scrollEl ? { left: `${p.scrollEl.offsetLeft + p.scrollEl.clientWidth}px` } : undefined}>
      {ticks.map((t, i) => <i key={i} className={t.cur ? "cur" : undefined} style={{ top: `${t.top}%` }} />)}
    </div>
  ) : null;
  const liveRegion = <span id="oc-find-count" className="fb-sr" aria-live="polite">{live}</span>;

  if (p.compact) {
    return (
      <>
        <div className="pfb" role="search" aria-label="Find in canvas" onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && (e.preventDefault(), close())}>
          <div className={"fb-in" + (bad ? " err" : "")}>
            <Search size={16} aria-hidden="true" />
            {input}
            <span className={"fb-c" + (bad ? " bad" : "")} aria-hidden="true">{count}</span>
          </div>
          <button type="button" className="pfb-done" onClick={close}>Done</button>
        </div>
        {errorLine ? <div className="pfb-msg">{errorLine}</div> : sub ? <div className="pfb-msg fb-sub-line">{sub}</div> : null}
        <div className="pfb-bar" role="toolbar" aria-label="Find">
          <button type="button" className="fb-b big" aria-label="Previous match" onClick={() => go(-1)}><ArrowUp size={18} aria-hidden="true" /></button>
          <button type="button" className="fb-b big" aria-label="Next match" onClick={() => go(1)}><ArrowDown size={18} aria-hidden="true" /></button>
          <span className="fb-grow" />
          {p.canReplace ? <button type="button" className="pfb-act" onClick={() => setSheet(true)}><Replace size={16} aria-hidden="true" />Replace</button> : null}
          <button type="button" className="pfb-act" onClick={() => setSheet(true)}><SlidersHorizontal size={16} aria-hidden="true" />Options</button>
        </div>
        {sheet ? (
          <div className="pfb-scrim" onClick={(e) => e.target === e.currentTarget && setSheet(false)}>
            <div className="pfb-sheet" role="dialog" aria-modal="true" aria-label="Replace and options">
              {p.canReplace ? (
                <>
                  <h3>Replace “{q}”</h3>
                  <input ref={repField} className="pfb-rep" value={rep} onChange={(e) => setRep(e.target.value)} onKeyDown={keyReplace} placeholder="Replace with" aria-label="Replace with" />
                  <div className="pfb-btns">
                    <button type="button" className="btn" onClick={replaceOne} disabled={!current}>Replace</button>
                    <button type="button" className="btn primary" onClick={replaceAll} disabled={!matches.length}>Replace all {matches.length || ""}</button>
                  </div>
                </>
              ) : null}
              <h3>Options</h3>
              {([["caseSensitive", "Match case"], ["wholeWord", "Whole word"], ["regex", "Use a pattern"]] as const).map(([k, label]) => (
                <label key={k} className="pfb-sw">
                  <span>{label}</span>
                  <input type="checkbox" role="switch" checked={opts[k]} onChange={() => toggle(k)} />
                </label>
              ))}
              <label className="pfb-sw">
                <span>Include comments (find only)</span>
                <input type="checkbox" role="switch" checked={opts.scope.comments} onChange={() => setOpts((o) => ({ ...o, scope: { ...o.scope, comments: !o.scope.comments } }))} />
              </label>
              <button type="button" className="btn pfb-close" onClick={() => setSheet(false)}>Close</button>
            </div>
          </div>
        ) : null}
        {liveRegion}
      </>
    );
  }

  return (
    <>
      <div className="fb" role="search" aria-label="Find in canvas" onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && (e.preventDefault(), close())}>
        <div className="fb-r">
          {p.canReplace ? (
            <button type="button" className={"fb-b" + (showReplace ? " on" : "")} aria-expanded={showReplace} aria-label={showReplace ? "Hide replace" : "Show replace"} title={`Replace (${isMac ? "⌘⌥F" : "Ctrl+H"})`} onClick={() => setShowReplace((v) => !v)}>
              <ChevronRight size={16} aria-hidden="true" className={showReplace ? "rot" : undefined} />
            </button>
          ) : null}
          <div className={"fb-in" + (bad ? " err" : "")}>
            <Search size={15} aria-hidden="true" />
            {input}
            {caseBtn}
            {wordBtn}
            {regexBtn}
          </div>
          <span className={"fb-c" + (bad ? " bad" : "")} aria-hidden="true">{count}</span>
          <button type="button" className="fb-b" aria-label="Previous match" title={isMac ? "Previous match (⇧↵)" : "Previous match (Shift+Enter)"} onClick={() => go(-1)} disabled={!matches.length}><ArrowUp size={16} aria-hidden="true" /></button>
          <button type="button" className="fb-b" aria-label="Next match" title={isMac ? "Next match (↵)" : "Next match (Enter)"} onClick={() => go(1)} disabled={!matches.length}><ArrowDown size={16} aria-hidden="true" /></button>
          <button type="button" className={"fb-b" + (menu ? " on" : "")} aria-label="Search options" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu((v) => !v)}><SlidersHorizontal size={16} aria-hidden="true" /></button>
          <button type="button" className="fb-b" aria-label="Close find" title="Close (Esc)" onClick={close}><X size={16} aria-hidden="true" /></button>
        </div>
        {showReplace && p.canReplace ? (
          <div className="fb-r">
            <span className="fb-sp" />
            <div className="fb-in">
              <Replace size={15} aria-hidden="true" />
              <input ref={repField} className="fb-field" value={rep} onChange={(e) => setRep(e.target.value)} onKeyDown={keyReplace} placeholder="Replace with" aria-label="Replace with" spellCheck={false} autoComplete="off" />
            </div>
            <button type="button" className="btn fb-btn" onClick={replaceOne} disabled={!current}>Replace</button>
            <button type="button" className="btn fb-btn" onClick={replaceAll} disabled={!matches.length} title={isMac ? "Replace all (⌘↵)" : "Replace all (Ctrl+Alt+Enter)"}><ReplaceAll size={15} aria-hidden="true" />Replace all</button>
          </div>
        ) : null}
        {errorLine}
        {sub && !errorLine ? <div className="fb-sub-line">{sub}</div> : null}
        {menu ? (
          <div className="fb-menu" role="group" aria-label="Search options">
            <div className="fb-mh">Match</div>
            <label className="fb-mi"><input type="checkbox" checked={opts.caseSensitive} onChange={() => toggle("caseSensitive")} />Match case</label>
            <label className="fb-mi"><input type="checkbox" checked={opts.wholeWord} onChange={() => toggle("wholeWord")} />Whole word</label>
            <label className="fb-mi"><input type="checkbox" checked={opts.regex} onChange={() => toggle("regex")} />Use a pattern (regular expression)</label>
            {scopeItems}
          </div>
        ) : null}
      </div>
      {ticksEl}
      {liveRegion}
    </>
  );
}

// ---------- DOM: cells, shapes, scrolling ----------

function clearDom() {
  document.querySelectorAll(".oc-find-cell, .oc-find-shape").forEach((el) => el.classList.remove("oc-find-cell", "oc-find-shape", "cur"));
}

function cellEl(m: Extract<Match, { kind: "cell" }>): HTMLElement | null {
  const host = document.querySelector<HTMLElement>(`[data-db="${CSS.escape(m.dbId)}"]`);
  const tr = host?.querySelector<HTMLElement>(`tr[data-row="${CSS.escape(m.rowId)}"]`);
  if (!host || !tr) return null;
  const ths = Array.from(host.querySelectorAll<HTMLElement>("th[data-fid]"));
  const col = ths.findIndex((th) => th.dataset.fid === m.fieldId);
  if (col < 0) return null;
  const tds = Array.from(tr.children).filter((c) => c.tagName === "TD") as HTMLElement[];
  // Rows may start with a gutter cell; align from the end of the header row.
  const offset = tds.length - ths.length;
  return tds[col + Math.max(0, offset)] ?? null;
}
function shapeEl(m: Extract<Match, { kind: "shape" }>): Element | null {
  return document.querySelector(`[data-board="${CSS.escape(m.boardId)}"] [data-s="${CSS.escape(m.shapeId)}"]`);
}

function markDom(matches: Match[], cur: number) {
  clearDom();
  matches.forEach((m, i) => {
    const el = m.kind === "cell" ? cellEl(m) : m.kind === "shape" ? shapeEl(m) : null;
    if (!el) return;
    el.classList.add(m.kind === "cell" ? "oc-find-cell" : "oc-find-shape");
    if (i === cur) el.classList.add("cur");
  });
}

function blockEl(editor: Editor, pos: number): HTMLElement | null {
  const dom = editor.view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/** Scrolls the current match to the upper third of the canvas, if it is not in view. */
function reveal(editor: Editor, m: Match, scroller: HTMLElement | null) {
  if (editor.isDestroyed) return;
  let el: Element | null = null;
  let top: number | null = null;
  if (m.kind === "text") {
    try {
      top = editor.view.coordsAtPos(m.from).top;
    } catch {
      top = null;
    }
  } else if (m.kind === "cell") el = cellEl(m) ?? blockEl(editor, m.pos);
  else if (m.kind === "shape") el = shapeEl(m) ?? blockEl(editor, m.pos);
  else if (m.kind === "live") el = blockEl(editor, m.pos);
  if (el) top = el.getBoundingClientRect().top;
  if (top == null || !scroller) return;
  const box = scroller.getBoundingClientRect();
  if (top < box.top + 64 || top > box.bottom - 64) {
    scroller.scrollTo({ top: scroller.scrollTop + (top - box.top) - box.height / 3, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

/** One tick per match (at most MAX_TICKS) at its place in the scrollable height, in percent. */
function tickPositions(editor: Editor, matches: Match[], cur: number, scroller: HTMLElement | null): { top: number; cur: boolean }[] {
  if (!scroller || editor.isDestroyed || !matches.length) return [];
  const box = scroller.getBoundingClientRect();
  const h = scroller.scrollHeight || 1;
  const step = Math.max(1, Math.ceil(matches.length / MAX_TICKS));
  const out: { top: number; cur: boolean }[] = [];
  for (let i = 0; i < matches.length; i++) {
    if (i % step && i !== cur) continue;
    const m = matches[i];
    let y: number | null = null;
    try {
      if (m.kind === "text") y = editor.view.coordsAtPos(m.from).top;
      else if (m.kind !== "comment") y = (blockEl(editor, m.pos)?.getBoundingClientRect().top ?? null);
    } catch {
      y = null;
    }
    if (y == null) continue;
    out.push({ top: Math.min(99.5, Math.max(0, ((y - box.top + scroller.scrollTop) / h) * 100)), cur: i === cur });
  }
  return out;
}
