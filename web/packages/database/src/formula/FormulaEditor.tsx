// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The formula editor (prototype 1a-1c, 5a): a code field with syntax colour, checked by the
// engine as you type; the inferred type and the first row's value under it; autocomplete of
// functions and fields with signature help; the error inline at its position; Save disabled
// while there is an error (no "save anyway"); Ctrl+Enter saves, Esc cancels. On a phone a row
// of insert chips sits above the keyboard.

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DbField, DbSnapshot } from "../types";
import { computedValue, TYPE_WORD } from "./cells";
import type { Engine, FuncDoc } from "./engine";
import type { Related } from "./hooks";

interface Tok {
  k: "fn" | "str" | "num" | "op" | "id" | "ws";
  s: string;
}

/** Colouring only; the engine decides what the formula means. */
export function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /("(?:[^"]|"")*"?)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][\w.]*)(?=\s*\()|([A-Za-z_][\w.]*)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push({ k: m[1] ? "str" : m[2] ? "num" : m[3] ? "fn" : m[4] ? "id" : m[5] ? "ws" : "op", s: m[0] });
  }
  return out;
}

function Highlight({ src, errAt }: { src: string; errAt: number | null }): ReactNode {
  let at = 0;
  const parts: ReactNode[] = [];
  tokens(src).forEach((t, i) => {
    const start = at;
    at += t.s.length;
    const cls = t.k === "fn" ? (t.s.toLowerCase() === "prop" ? "t-op" : "t-fn") : t.k === "str" ? "t-str" : t.k === "num" ? "t-num" : t.k === "op" ? "t-op" : undefined;
    const hit = errAt != null && errAt >= start && errAt < at && t.k !== "ws";
    const el = <span key={i} className={cls}>{t.s}</span>;
    parts.push(hit ? <mark key={"m" + i}>{el}</mark> : el);
  });
  if (errAt != null && errAt >= src.length) parts.push(<mark key="end">{" "}</mark>);
  return <>{parts}{"\n"}</>;
}

/** The word being typed at the caret, and the function call the caret is inside. */
export function caretInfo(src: string, caret: number): { word: string; from: number; inProp: boolean; call: string | null } {
  const before = src.slice(0, caret);
  const pm = /prop\(\s*"([^"]*)$/i.exec(before);
  if (pm) return { word: pm[1], from: caret - pm[1].length, inProp: true, call: null };
  const wm = /[A-Za-z_][\w.]*$/.exec(before);
  let depth = 0, call: string | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === '"') {
      const j = before.lastIndexOf('"', i - 1);
      if (j < 0) break;
      i = j;
    } else if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const n = /([A-Za-z_][\w.]*)\s*$/.exec(before.slice(0, i));
        call = n ? n[1].toUpperCase() : null;
        if (call === "PROP") call = null;
        break;
      }
      depth--;
    }
  }
  return { word: wm ? wm[0] : "", from: caret - (wm ? wm[0].length : 0), inProp: false, call };
}

const TYPE_LABEL = (t?: string) => (t ? TYPE_WORD[t] ?? t : "");

export interface FormulaEditorProps {
  engine: Engine;
  db: DbSnapshot;
  f: DbField;
  related: Related;
  compact: boolean;
  onSave: (src: string) => void;
  onCancel: () => void;
}

export function FormulaEditor({ engine, db, f, related, compact, onSave, onCancel }: FormulaEditorProps) {
  const [src, setSrc] = useState(f.formula ?? "");
  const [caret, setCaret] = useState(src.length);
  const [acIdx, setAcIdx] = useState(0);
  const [acOff, setAcOff] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const funcs = useMemo<FuncDoc[]>(() => engine.functions(), [engine]);
  const others = db.fields.filter((x) => x.id !== f.id);
  const res = useMemo(() => (src.trim() ? engine.check({ fields: db.fields, id: f.id, formula: src }) : null), [engine, db.fields, f.id, src]);
  const first = db.rows[0];
  const preview = useMemo(() => {
    if (!res?.ok || !first) return undefined;
    const fields = db.fields.map((x) => (x.id === f.id ? { ...x, type: "formula" as const, formula: src } : x));
    try {
      return engine.compute({ fields, rows: [first], related }).rows[first.id]?.[f.id];
    } catch {
      return undefined;
    }
  }, [engine, res, first, db.fields, f.id, src, related]);
  useLayoutEffect(() => {
    ta.current?.focus({ preventScroll: true });
  }, []);

  const info = caretInfo(src, caret);
  const q = info.word.toLowerCase();
  const items: { label: string; insert: string; sub: string }[] = acOff || (!q && !info.inProp)
    ? []
    : info.inProp
      ? others.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 8).map((x) => ({ label: x.name, insert: x.name.replace(/"/g, '""') + '")', sub: x.type }))
      : [
          ...funcs.filter((x) => x.name.toLowerCase().startsWith(q)).map((x) => ({ label: x.name, insert: x.name + "(", sub: x.doc })),
          ...("prop".startsWith(q) ? others.slice(0, 6).map((x) => ({ label: `prop("${x.name}")`, insert: `prop("${x.name.replace(/"/g, '""')}")`, sub: x.type })) : []),
        ].slice(0, 8);
  const sig = info.call ? funcs.find((x) => x.name === info.call) : undefined;

  const insertAt = (text: string, from = caret, to = caret) => {
    const next = src.slice(0, from) + text + src.slice(to);
    const pos = from + text.length;
    setSrc(next);
    setCaret(pos);
    setAcOff(false);
    setAcIdx(0);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
    });
  };
  const accept = (i: number) => {
    const it = items[i];
    if (it) insertAt(it.insert, info.from, caret);
  };
  const save = () => {
    if (res?.ok) onSave(res.normalized);
  };
  const err = res && !res.ok ? res.error : null;
  const acId = `ocdb-fx-ac-${f.id}`;

  return (
    <div className="ocdb-fx" role="group" aria-label={`${f.name}: formula`}>
      <div className="ocdb-fx-h">{f.name} · Formula</div>
      <div className="ocdb-fx-code">
        <pre aria-hidden="true"><Highlight src={src} errAt={err ? err.pos : null} /></pre>
        <textarea
          ref={ta}
          value={src}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Formula"
          aria-invalid={!!err}
          aria-describedby={`${acId}-st`}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={acId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? `${acId}-${acIdx}` : undefined}
          placeholder='prop("Price") * prop("Qty")'
          onChange={(e) => {
            setSrc(e.target.value);
            setCaret(e.target.selectionStart);
            setAcOff(false);
            setAcIdx(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (items.length) setAcOff(true);
              else onCancel();
            } else if (items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setAcIdx((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
            } else if (items.length && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              accept(acIdx);
            } else if (e.key === "Enter") e.preventDefault();
          }}
        />
      </div>
      {items.length ? (
        <ul className="ocdb-fx-ac" id={acId} role="listbox" aria-label="Suggestions">
          {items.map((it, i) => (
            <li key={it.label} id={`${acId}-${i}`} role="option" aria-selected={i === acIdx} onMouseDown={(e) => (e.preventDefault(), accept(i))}>
              <code>{it.label}</code>
              <span>{it.sub}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {sig ? <div className="ocdb-fx-sig">{sig.sig}</div> : null}
      <div id={`${acId}-st`} aria-live="polite">
        {err ? (
          <div className="ocdb-fx-err"><b>{err.code}</b> {err.msg}</div>
        ) : res?.ok ? (
          <div className="ocdb-fx-meta">
            <span className="ocdb-fx-type">{TYPE_LABEL(res.type)}</span>
            {first ? <span>First row: {computedValue(f, preview)}</span> : null}
          </div>
        ) : (
          <div className="ocdb-fx-meta">Fields are read with prop("Name"). Functions: IF, SUM, ROUND, DATEADD…</div>
        )}
      </div>
      {compact ? (
        <div className="ocdb-fx-chips" aria-label="Insert">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertAt('prop("')}>prop("…")</button>
          {["IF(", "SUM(", "ROUND(", " * ", " + ", " & "].map((c) => (
            <button type="button" key={c} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAt(c)}>{c.trim().replace("(", "")}</button>
          ))}
        </div>
      ) : null}
      <div className="ocdb-fx-ft">
        {!compact ? <span className="ocdb-hintk"><kbd>Ctrl</kbd> <kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel</span> : null}
        <button type="button" className="ocdb-btn sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="ocdb-btn sm primary" disabled={!res?.ok} onClick={save}>Save</button>
      </div>
    </div>
  );
}
