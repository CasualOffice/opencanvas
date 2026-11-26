// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// "Search all canvases" (SRCH-04, approved prototype docs/prototypes/v03-approved/search.html
// frames 2a-2e, 4a, 5c). A centred dialog (full screen on phones) over the canvas that asks
// the host's search, as this person, through `GET /v1/search`. Loaded when first opened.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Clock, CornerDownLeft, FileSearch, FileText, Search, SearchX, TriangleAlert, X } from "lucide-react";
import { group, highlight, parseAnswer, recents, remember, savedLabel, type Answer, type Hit } from "./model";
import "./search.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** After this the dialog shows a thin progress line. */
const SLOW_MS = 2000;
/** The server gives up on the host at 8 s; the dialog waits a little longer for its answer. */
const GIVE_UP_MS = 9000;

export interface SearchAllProps {
  ticket: string;
  hostName: string;
  /** The canvas open now: a result in it just scrolls. */
  fileId: string;
  compact: boolean;
  onClose(): void;
  /** A result in this canvas: scroll to the block and open find with the query. */
  onOpenHere(blockId: string | undefined, q: string): void;
  /** A result in another canvas: the host navigates (`UI_OpenFile`). */
  onOpenFile(hit: Hit, newTab: boolean): void;
}

type St =
  | { kind: "idle" }
  | { kind: "loading"; slow: boolean; prev?: Answer }
  | { kind: "done"; answer: Answer }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

function Snip({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text, q).map((r, i) => (r.hit ? <mark key={i} className="sa-mark">{r.text}</mark> : <span key={i}>{r.text}</span>))}
    </>
  );
}

export function SearchAll(p: SearchAllProps) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<string | null>(null);
  const [st, setSt] = useState<St>({ kind: "idle" });
  const [active, setActive] = useState(0);
  const [again, setAgain] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const [recent] = useState(recents);

  useEffect(() => {
    field.current?.focus();
    const el = back.current;
    return () => {
      if (el instanceof HTMLElement) el.focus();
    };
  }, []);

  useEffect(() => {
    const t = q.trim();
    if (!t) {
      setSt({ kind: "idle" });
      return;
    }
    const ac = new AbortController();
    let slow = 0;
    const debounce = window.setTimeout(async () => {
      setSt((s) => ({ kind: "loading", slow: false, prev: s.kind === "done" ? s.answer : s.kind === "loading" ? s.prev : undefined }));
      slow = window.setTimeout(() => setSt((s) => (s.kind === "loading" ? { ...s, slow: true } : s)), SLOW_MS);
      const giveUp = window.setTimeout(() => ac.abort("timeout"), GIVE_UP_MS);
      try {
        const u = new URLSearchParams({ ticket: p.ticket, q: t });
        if (scope) u.set("scope", scope);
        const r = await fetch(`/v1/search?${u}`, { signal: ac.signal, cache: "no-store" });
        if (r.status === 504) return setSt({ kind: "timeout" });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { detail?: string; code?: string };
          return setSt({ kind: "error", message: r.status === 429 ? "Too many searches. Wait a moment and try again." : body.detail || `${p.hostName} could not search right now.` });
        }
        const answer = parseAnswer(await r.json());
        setSt({ kind: "done", answer });
        setActive(0);
        remember(t);
      } catch (e) {
        if (ac.signal.reason === "timeout") setSt({ kind: "timeout" });
        else if (!ac.signal.aborted) setSt({ kind: "error", message: `${p.hostName} could not be reached.` });
      } finally {
        window.clearTimeout(slow);
        window.clearTimeout(giveUp);
      }
    }, 220);
    return () => {
      window.clearTimeout(debounce);
      window.clearTimeout(slow);
      ac.abort();
    };
  }, [q, scope, again, p.ticket, p.hostName]);

  const answer = st.kind === "done" ? st.answer : st.kind === "loading" ? st.prev : undefined;
  const groups = useMemo(() => (answer ? group(answer.items) : []), [answer]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const scopes = answer?.scopes ?? [];

  useEffect(() => {
    listRef.current?.querySelector(`#sa-hit-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (h: Hit | undefined, newTab: boolean) => {
    if (!h) return;
    remember(q);
    if (h.fileId === p.fileId && !newTab) p.onOpenHere(h.blockId, q.trim());
    else p.onOpenFile(h, newTab);
    p.onClose();
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return p.onClose();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!q.trim() && recent.length) return setQ(recent[0]);
      open(flat[active], isMac ? e.metaKey : e.ctrlKey);
    }
  };

  const footer = (
    <div className="sa-f">
      {!p.compact ? (
        <>
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd><CornerDownLeft size={11} aria-hidden="true" /></kbd> open</span>
          <span><kbd>{isMac ? "⌘" : "Ctrl"}</kbd><kbd><CornerDownLeft size={11} aria-hidden="true" /></kbd> open in a new tab</span>
          <span className="sa-grow" />
        </>
      ) : null}
      <span className="sa-src"><FileSearch size={13} aria-hidden="true" />Results from {p.hostName} · they update when a canvas is saved</span>
    </div>
  );

  let body: React.ReactNode;
  if (!q.trim()) {
    body = (
      <>
        {recent.length ? (
          <>
            <div className="sa-cap" id="sa-recent">Recent</div>
            <div role="list" aria-labelledby="sa-recent">
              {recent.map((r) => (
                <button key={r} type="button" role="listitem" className="sa-rec" onClick={() => setQ(r)}>
                  <Clock size={15} aria-hidden="true" />
                  {r}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <p className="sa-hint"><Search size={14} aria-hidden="true" />Searches the canvases you can open in {p.hostName}: text, tables and boards.</p>
      </>
    );
  } else if (st.kind === "timeout" || st.kind === "error") {
    body = (
      <div className="sa-empty" role="alert">
        <span className="sa-ei"><TriangleAlert size={20} aria-hidden="true" /></span>
        <h4>{st.kind === "timeout" ? `${p.hostName} did not answer in time` : "Search didn't work"}</h4>
        <p>{st.kind === "timeout" ? "Your canvases are fine. Try the search again in a moment." : st.message}</p>
        <button type="button" className="btn" onClick={() => setAgain((n) => n + 1)}>Try again</button>
      </div>
    );
  } else if (answer && !flat.length && st.kind === "done") {
    const widen = scope && scopes[0] && scope !== scopes[0].id;
    body = (
      <div className="sa-empty">
        <span className="sa-ei"><SearchX size={20} aria-hidden="true" /></span>
        <h4>No canvases match “{q.trim()}”</h4>
        <p>Try fewer words{widen ? `, or search ${scopes[0].label.toLowerCase()} instead of ${scopes.find((s) => s.id === scope)?.label ?? "this scope"}` : ""}. A canvas edited in the last minute may not be searchable yet.</p>
        {widen ? <button type="button" className="btn" onClick={() => setScope(scopes[0].id)}>Search {scopes[0].label.toLowerCase()}</button> : null}
      </div>
    );
  } else {
    body = (
      <>
        {answer?.partial ? (
          <div className="sa-part" role="status">
            <span>{p.hostName} searched part of your files in time. Some canvases may be missing.</span>
            <button type="button" className="sa-a" onClick={() => setAgain((n) => n + 1)}>Search again</button>
          </div>
        ) : null}
        <div role="listbox" id="sa-list" aria-label="Results" ref={listRef}>
          {groups.map((g) => (
            <div key={g.fileId} className="sa-g" role="group" aria-label={g.title}>
              <div className="sa-gh" aria-hidden="true">
                <FileText size={15} />
                <b>{g.title}</b>
                {g.fileId === p.fileId ? <span className="sa-path">This canvas</span> : null}
                <span className="sa-grow" />
                <span className="sa-when">{savedLabel(g.updatedAt)}</span>
              </div>
              {g.hits.map((h) => (
                <div
                  key={h.index}
                  id={`sa-hit-${h.index}`}
                  role="option"
                  aria-selected={h.index === active}
                  className={"sa-hit" + (h.index === active ? " on" : "")}
                  onMouseMove={() => setActive(h.index)}
                  onClick={(e) => open(h, isMac ? e.metaKey : e.ctrlKey)}
                >
                  {h.path ? <span className="sa-trail">{h.path}</span> : null}
                  <span className="sa-snip"><Snip text={h.snippet} q={q} /></span>
                  {h.index === active && !p.compact ? <CornerDownLeft size={14} className="sa-ent" aria-hidden="true" /> : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </>
    );
  }

  const busy = st.kind === "loading";
  return (
    <div className={"sa-scrim" + (p.compact ? " psa" : "")} onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="sa" role="dialog" aria-modal="true" aria-label="Search all canvases">
        <div className="sa-h">
          {p.compact ? (
            <button type="button" className="sa-x" aria-label="Back to the canvas" onClick={p.onClose}><ChevronLeft size={20} aria-hidden="true" /></button>
          ) : (
            <Search size={18} aria-hidden="true" />
          )}
          <input
            ref={field}
            className="sa-q"
            type="search"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="sa-list"
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? `sa-hit-${active}` : undefined}
            aria-label="Search all canvases"
            placeholder="Search all canvases"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={key}
            spellCheck={false}
            autoComplete="off"
            maxLength={200}
          />
          {!p.compact ? <kbd className="sa-kb">Esc</kbd> : null}
          {!p.compact ? <button type="button" className="sa-x" aria-label="Close" onClick={p.onClose}><X size={16} aria-hidden="true" /></button> : null}
        </div>
        {busy && st.slow ? <div className="sa-prog" role="progressbar" aria-label="Searching"><i /></div> : null}
        {scopes.length > 1 ? (
          <div className="sa-sc" role="radiogroup" aria-label="Where to search">
            {scopes.map((s, i) => {
              const on = (scope ?? scopes[0].id) === s.id || (!scope && i === 0);
              return (
                <button key={s.id} type="button" role="radio" aria-checked={on} className={"sa-chip" + (on ? " on" : "")} onClick={() => setScope(s.id)}>
                  {s.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="sa-b" aria-busy={busy}>{body}</div>
        <span className="sa-sr" aria-live="polite">{st.kind === "done" ? (flat.length ? `${flat.length} results` : "No results") : ""}</span>
        {footer}
      </div>
    </div>
  );
}
