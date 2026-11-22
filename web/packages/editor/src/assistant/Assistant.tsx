// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The assistant UI (docs/24 §10.2), built to the approved prototype
// (docs/prototypes/assistant-approved: Main.dc.html desktop, Phone.dc.html phone).
// Lazy chunk: loads only when the assistant is on for this person.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { Role } from "@opencanvas/ui";
import {
  AlignLeft, ArrowUp, ChevronLeft, ChevronRight, CircleHelp, Database, LayoutDashboard, ListChecks, ListTodo, LoaderCircle, MessageSquare,
  PenLine, ShieldCheck, Sparkles, Square, TriangleAlert, Undo2, type LucideIcon,
} from "lucide-react";
import { aiOpenHandled, aiOpenStore, aiStore, aiUiStore, type AiMode } from "../lib/assistant";
import { useStore } from "../lib/store";
import { isMac } from "../lib/keys";
import { actionsFor, barKey, initialRun, newRunId, placeholderFor, reduce, type Action, type Mode, type PlanStep, type Selection } from "./model";
import { acceptSuggestion, readSuggestions, rejectSuggestion, suggestionsRoot, type Suggestion } from "./suggestions";
import { assistantPlugin, decoKey, type DecoModel } from "./deco";
import type { Transport } from "./transport";
import "./assistant.css";

const ICON: Record<string, LucideIcon> = {
  "align-left": AlignLeft, "circle-help": CircleHelp, database: Database, "layout-dashboard": LayoutDashboard, "list-todo": ListTodo,
  "message-square": MessageSquare, "pen-line": PenLine, "triangle-alert": TriangleAlert,
};
const I = ({ c: C, size = 16, className, style }: { c: LucideIcon; size?: number; className?: string; style?: React.CSSProperties }) => (
  <C size={size} strokeWidth={2} className={"ai-i " + (className ?? "")} style={style} aria-hidden="true" />
);

/** `**bold**` in plan text, nothing else: model text is rendered as text. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p))}</>;
}

interface Captured {
  sel: Selection;
  range: { from: number; to: number } | null;
  slotAt: number;
}

/** What the selection is, its lines (plain text) and the block ids they live in. */
export function captureSelection(editor: Editor): Captured {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  const blocks: { text: string; id: string | null; from: number; to: number }[] = [];
  let inList = false;
  if (!empty)
    state.doc.nodesBetween(from, to, (n, pos) => {
      if (!n.isTextblock) return true;
      const $p = state.doc.resolve(pos + 1);
      let id: string | null = null;
      for (let d = $p.depth; d > 0 && !id; d--) {
        const a = $p.node(d);
        if (/listItem|taskItem/.test(a.type.name)) inList = true;
        if (typeof a.attrs.blockId === "string" && a.attrs.blockId) id = a.attrs.blockId;
      }
      if (n.textContent.trim()) blocks.push({ text: n.textContent, id, from: pos + 1, to: pos + n.nodeSize - 1 });
      return false;
    });
  const $to = state.doc.resolve(to);
  const slotAt = $to.depth >= 1 ? $to.after(1) : to;
  if (empty || !blocks.length) return { sel: { kind: "none", lines: [], blockIds: [] }, range: null, slotAt };
  const lines = blocks.length > 1 || inList;
  return {
    sel: {
      kind: lines ? "lines" : "text",
      lines: lines ? blocks.map((b) => b.text) : [state.doc.textBetween(from, to, "\n")],
      blockIds: [...new Set(blocks.map((b) => b.id).filter((x): x is string => !!x))],
    },
    range: lines ? { from: blocks[0].from, to: blocks[blocks.length - 1].to } : { from, to },
    slotAt,
  };
}

function allBlockIds(editor: Editor): Set<string> {
  const s = new Set<string>();
  editor.state.doc.descendants((n) => {
    if (typeof n.attrs?.blockId === "string" && n.attrs.blockId) s.add(n.attrs.blockId);
    return true;
  });
  return s;
}

export interface AssistantProps {
  editor: Editor;
  doc: Y.Doc;
  awareness: Awareness;
  transport: Transport;
  role: Role;
  compact: boolean;
  hostName: string;
}

export default function Assistant({ editor, doc, awareness, transport, role, compact, hostName }: AssistantProps) {
  const flag = useStore(aiStore);
  const [run, dispatch] = useReducer(reduce, initialRun);
  const [cap, setCap] = useState<Captured | null>(null);
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState("");
  const [sent, setSent] = useState(false);
  const [suggs, setSuggs] = useState<Suggestion[]>(() => readSuggestions(doc));
  const [cursor, setCursor] = useState(0);
  const [agent, setAgent] = useState<{ blockId: string; runId: string } | null>(null);
  const [created, setCreated] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const startIds = useRef<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const runBtn = useRef<HTMLButtonElement>(null);
  const reviewFirst = useRef<HTMLButtonElement>(null);
  const answerBtn = useRef<HTMLButtonElement>(null);
  const runRef = useRef(run);
  runRef.current = run;

  const modes = flag.modes as AiMode[];
  const answerOnly = !modes.includes("edit");
  const actions = useMemo(() => (cap ? actionsFor(cap.sel, answerOnly ? "comment" : role) : []), [cap, role, answerOnly]);

  // ---------- the in-document layer ----------
  const slot = useMemo(() => {
    const d = document.createElement("div");
    d.className = "ai-slot ai-ui";
    d.contentEditable = "false";
    return d;
  }, []);
  const accept = useCallback((id: string) => {
    const s = readSuggestions(doc).find((x) => x.id === id);
    if (s && role === "edit") acceptSuggestion(editor, doc, s);
  }, [editor, doc, role]);
  const reject = useCallback((id: string) => role === "edit" && rejectSuggestion(doc, id), [doc, role]);
  const mine = run.runId ? `ai:${run.runId}` : null;
  const pending = suggs.filter((s) => s.status === "pending" && s.origin === mine);
  const cur = pending.length ? Math.min(cursor, pending.length - 1) : -1;
  const showSlot = !compact && (run.phase === "bar" || run.phase === "waiting" || run.phase === "plan" || run.phase === "answer");
  const stepLabel = run.stepShort ? run.stepShort[0].toLowerCase() + run.stepShort.slice(1) : "working";
  const model: DecoModel = {
    sel: (run.phase === "bar" || run.phase === "waiting" || run.phase === "plan") && cap?.range ? cap.range : null,
    slotAt: showSlot && cap ? cap.slotAt : null,
    agent: agent ? { blockId: agent.blockId, label: created.includes(agent.blockId) ? `Assistant · ${stepLabel}` : "Assistant" } : null,
    created: run.phase === "acting" || run.phase === "review" ? created : [],
    newTag: run.phase === "review",
    suggestions: suggs,
    focus: run.phase === "review" && cur >= 0 ? pending[cur].id : null,
    canAccept: role === "edit",
    onAccept: accept,
    onReject: reject,
  };
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    editor.registerPlugin(assistantPlugin(slot, modelRef.current));
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(decoKey);
    };
  }, [editor, slot]);
  const key = JSON.stringify([model.sel, model.slotAt, model.agent, model.created, model.newTag, model.focus, model.canAccept, suggs.map((s) => [s.id, s.status])]);
  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(decoKey, modelRef.current).setMeta("addToHistory", false));
  }, [editor, key]);

  // The selection toolbar steps aside while the bar or plan is open.
  useEffect(() => {
    aiUiStore.set(run.phase !== "closed");
    return () => aiUiStore.set(false);
  }, [run.phase]);

  // ---------- suggestions root ----------
  useEffect(() => {
    const root = suggestionsRoot(doc);
    const f = () => setSuggs(readSuggestions(doc));
    root.observeDeep(f);
    f();
    return () => root.unobserveDeep(f);
  }, [doc]);

  // ---------- the run's messages ----------
  useEffect(() => transport.on((m) => dispatch({ e: "msg", m })), [transport]);

  // ---------- the agent in awareness (any run; ours first) ----------
  useEffect(() => {
    const f = () => {
      let hit: { blockId: string; runId: string } | null = null;
      awareness.getStates().forEach((st) => {
        const u = st.user as { id?: unknown } | undefined;
        const c = st.cursor as { blockId?: unknown } | undefined;
        if (st.agent !== true || typeof u?.id !== "string" || typeof c?.blockId !== "string") return;
        const runId = u.id.replace(/^ai:/, "");
        if (!hit || runId === runRef.current.runId) hit = { blockId: c.blockId, runId };
      });
      setAgent((prev) => (prev?.blockId === hit?.blockId && prev?.runId === hit?.runId ? prev : hit));
      if (hit && (hit as { runId: string }).runId === runRef.current.runId && !startIds.current.has((hit as { blockId: string }).blockId)) {
        const b = (hit as { blockId: string }).blockId;
        setCreated((c) => (c.includes(b) ? c : [...c, b]));
      }
    };
    awareness.on("change", f);
    f();
    return () => awareness.off("change", f);
  }, [awareness]);

  // Follow: keep the agent's block in view.
  useEffect(() => {
    if (!follow || run.phase !== "acting" || !agent) return;
    const el = editor.view.dom.querySelector(".ai-touch");
    el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }, [follow, run.phase, agent, editor, run.stepNo]);

  // ---------- open (toolbar, ⌘J, /assistant, header, phone bar) ----------
  const opens = useStore(aiOpenStore);
  useEffect(() => {
    if (opens === aiOpenHandled.n) return;
    aiOpenHandled.n = opens;
    if (runRef.current.phase === "acting" || runRef.current.phase === "review") return;
    setCap(captureSelection(editor));
    setActive(0);
    setTyped("");
    setSent(false);
    dispatch({ e: "open" });
  }, [opens, editor]);

  // Focus follows the step (WCAG 2.4.3): input → Run → review → answer.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (run.phase === "bar") {
        if (!compact) slot.scrollIntoView({ block: "nearest" });
        inputRef.current?.focus();
      }
      else if (run.phase === "plan") runBtn.current?.focus();
      else if (run.phase === "review") reviewFirst.current?.focus();
      else if (run.phase === "answer") answerBtn.current?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [run.phase]);

  const close = (refocus = true) => {
    if (run.runId && (run.phase === "waiting" || run.phase === "plan")) transport.cancel(run.runId);
    dispatch({ e: "finish" });
    setCap(null);
    if (refocus && !compact) editor.commands.focus();
  };

  const start = (prompt: string, mode: Mode) => {
    if (!cap || !prompt.trim()) return;
    const m: Mode = modes.includes(mode) ? mode : (modes[modes.length - 1] as Mode);
    const runId = newRunId();
    setCreated([]);
    setCursor(0);
    setFollow(true);
    dispatch({ e: "start", runId, prompt, mode: m });
    transport.run({ runId, prompt, mode: m, selection: cap.sel });
  };
  const choose = (a: Action) => start(a.prompt, a.mode);
  const approve = () => {
    if (!run.runId) return;
    // Blocks that exist now are not "new", even if the run only gave them ids while planning.
    startIds.current = allBlockIds(editor);
    transport.approve(run.runId);
    dispatch({ e: "approve" });
  };
  const changePlan = () => {
    if (run.runId) transport.cancel(run.runId);
    const p = run.prompt;
    dispatch({ e: "finish" });
    dispatch({ e: "open" });
    setTyped(p);
  };

  const onBarKey = (e: React.KeyboardEvent) => {
    const r = barKey(e.key, active, actions.length, typed);
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape") e.preventDefault();
    setActive(r.active);
    if (r.close) return close();
    if (r.run === "typed") start(typed, modes.includes("edit") ? "edit" : "answer");
    else if (r.run === "action" && actions[r.active]) choose(actions[r.active]);
  };

  const acceptAll = () => {
    for (const s of pending) acceptSuggestion(editor, doc, s);
  };
  const undoRun = () => run.runId && transport.undo(run.runId);
  const finish = () => {
    dispatch({ e: "finish" });
    setCap(null);
    setCreated([]);
  };

  // Review: the focused suggestion stays in view.
  useEffect(() => {
    if (run.phase !== "review" || cur < 0) return;
    const el = editor.view.dom.querySelector(`[data-sugg="${CSS.escape(pending[cur].id)}"]`);
    el?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, run.phase, pending.length]);

  if (!flag.on) return null;

  const canWord = role === "edit" && !answerOnly ? "can edit" : "can comment";
  const security = transport.demo
    ? `Acts as you (${canWord}). Demo: a scripted run, no AI server.`
    : `Acts as you (${canWord}). The selection is sent to ${hostName}'s AI server.`;
  const whatSent = (
    <p className="ai-sent" id="ai-sent">
      {transport.demo
        ? "Nothing leaves this browser: the demo plays a scripted run on this page."
        : `Sent: the ${cap?.sel.kind === "none" ? "canvas text" : "selected text"}, the canvas title and your role. Not sent: your sign-in, files, comments you can't see, or anything outside this canvas.`}
    </p>
  );

  const kbdRun = (
    <span className="ai-kbd on-ai" aria-hidden="true">
      ↵
    </span>
  );

  const planList = (steps: PlanStep[]) => (
    <ol className="ai-plan">
      {steps.map((s) => (
        <li key={s.n}>
          <span className={"ai-kbd" + (s.kind === "suggest" ? " sugg" : "")} aria-hidden="true">
            {s.n}
          </span>
          <span>
            <Rich text={s.text} />
            {s.kind === "suggest" ? <span className="ai-sr"> (a suggestion: you approve each change)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );

  const injected = run.injected ? (
    <div role="note" className="ai-note">
      <I c={TriangleAlert} size={14} style={{ marginTop: 1 }} />
      <span>{run.injected}</span>
    </div>
  ) : null;

  // ---------- desktop: inline in the document ----------
  const desktopCard =
    run.phase === "bar" && cap ? (
      <div className="ai-card" role="dialog" aria-label="Ask the assistant about the selection" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), close())}>
        <div className="ai-bar-in">
          <I c={Sparkles} style={{ color: "var(--ai)" }} />
          <label htmlFor="ai-cmd" className="ai-sr">
            What should the assistant do with the selection?
          </label>
          <input
            id="ai-cmd"
            ref={inputRef}
            placeholder={placeholderFor(cap.sel)}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onBarKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="ai-acts"
            aria-activedescendant={typed.trim() ? undefined : `ai-act-${active}`}
            autoComplete="off"
          />
          <span className="ai-kbd" aria-hidden="true">
            Esc
          </span>
        </div>
        <div className="ai-acts" id="ai-acts" role="listbox" aria-label="Suggested actions">
          {actions.map((a, i) => {
            const C = ICON[a.icon] ?? ListChecks;
            return (
              <button
                key={a.id}
                id={`ai-act-${i}`}
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                className={"ai-row" + (i === active ? " on" : "")}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(a)}
              >
                <I c={C} style={{ color: "var(--fg-2)" }} />
                <span className="grow">{a.label}</span>
                {a.note ? <span className="ai-note-r">{a.note}</span> : null}
                {i === active ? (
                  <span className="ai-kbd" aria-hidden="true">
                    ↵
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="ai-foot">
          <I c={ShieldCheck} size={14} />
          <span className="grow">{security}</span>
          <button className="ai-link" aria-expanded={sent} aria-controls="ai-sent" onClick={() => setSent((v) => !v)}>
            What is sent
          </button>
        </div>
        {sent ? whatSent : null}
      </div>
    ) : run.phase === "waiting" ? (
      <div className="ai-card ai-planc" aria-busy="true">
        <div className="ai-ph">
          <I c={LoaderCircle} className="ai-spin" style={{ color: "var(--ai)" }} />
          <strong className="grow">Planning</strong>
          <span className="ai-sub">Nothing changes until you run it</span>
        </div>
        <div className="ai-actions">
          <button className="ai-b" onClick={() => close()}>
            Cancel
          </button>
        </div>
      </div>
    ) : run.phase === "plan" ? (
      <div className="ai-card ai-planc" role="dialog" aria-label="The assistant's plan" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), close())}>
        <div className="ai-ph">
          <I c={ListChecks} style={{ color: "var(--ai)" }} />
          <strong className="grow">Here's the plan</strong>
          <span className="ai-sub">{transport.demo ? "Demo: a scripted run, no AI server" : "Nothing changes until you run it"}</span>
        </div>
        {planList(run.plan)}
        {injected}
        <div className="ai-actions">
          <button className="ai-b ai" ref={runBtn} onClick={approve}>
            Run{kbdRun}
          </button>
          <button className="ai-b out" onClick={changePlan}>
            Change the plan
          </button>
          <button className="ai-b" onClick={() => close()}>
            Cancel
          </button>
        </div>
      </div>
    ) : run.phase === "answer" ? (
      <div className="ai-card ai-planc" role="dialog" aria-label="The assistant's answer">
        <div className="ai-ph">
          <I c={Sparkles} style={{ color: "var(--ai)" }} />
          <strong className="grow">Assistant</strong>
          {transport.demo ? <span className="ai-sub">Demo: a scripted run, no AI server</span> : null}
        </div>
        <p className="ai-answer">{run.summary}</p>
        <div className="ai-actions">
          <button className="ai-b out" ref={answerBtn} onClick={() => close()}>
            Done
          </button>
        </div>
      </div>
    ) : null;

  // ---------- phone: action sheet ----------
  const sheetOpen = compact && (run.phase === "bar" || run.phase === "waiting" || run.phase === "plan" || run.phase === "answer");
  const sheet = sheetOpen ? (
    <div className="ai-ui ai-phone">
      <div className="ai-backdrop" aria-hidden="true" onClick={() => close(false)} />
      <section className="ai-sheet" role="dialog" aria-modal="true" aria-label="Assistant" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), close(false))}>
        <div className="ai-grab" aria-hidden="true" />
        {run.phase === "bar" && cap ? (
          <>
            <p className="ai-with">{cap.sel.kind === "lines" ? `With the ${cap.sel.lines.length} selected line${cap.sel.lines.length === 1 ? "" : "s"}` : cap.sel.kind === "text" ? "With the selection" : "With this canvas"}</p>
            {actions.slice(0, 3).map((a, i) => {
              const C = ICON[a.icon] ?? ListChecks;
              return (
                <button key={a.id} className={"ai-prow" + (i === 0 ? " first" : "")} onClick={() => choose(a)}>
                  <I c={C} size={18} style={{ color: "var(--fg-2)" }} />
                  {a.id === "tasks" && a.label.startsWith("Make a task database") ? "Make a task database" : a.id === "summarise" ? "Summarise" : a.label}
                </button>
              );
            })}
            <form
              className="ai-pin"
              onSubmit={(e) => {
                e.preventDefault();
                start(typed, modes.includes("edit") ? "edit" : "answer");
              }}
            >
              <label htmlFor="ai-pq" className="ai-sr">
                Ask the assistant
              </label>
              <input id="ai-pq" ref={inputRef} placeholder="Or say what to do" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" enterKeyHint="send" />
              <button className="ai-b ai ib" aria-label="Send" type="submit">
                <I c={ArrowUp} size={18} />
              </button>
            </form>
            <p className="ai-psec">{security.replace(" (can edit)", "").replace(" (can comment)", "")}</p>
          </>
        ) : run.phase === "waiting" ? (
          <div className="ai-pplan" aria-busy="true">
            <strong>
              <I c={LoaderCircle} size={18} className="ai-spin" style={{ color: "var(--ai)", verticalAlign: "-3px", marginRight: 8 }} />
              Planning
            </strong>
            <p className="ai-psub">Nothing changes until you run it.</p>
            <div className="ai-prun">
              <button className="ai-b out" onClick={() => close(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : run.phase === "plan" ? (
          <div className="ai-pplan">
            <strong>Here's the plan</strong>
            <ol>
              {run.plan.map((s) => (
                <li key={s.n}>
                  <Rich text={s.text} />
                  {s.kind === "suggest" ? <span className="ai-sr"> (a suggestion: you approve each change)</span> : null}
                </li>
              ))}
            </ol>
            {injected}
            <p className="ai-psub">{transport.demo ? "Demo: a scripted run, no AI server. " : ""}Nothing changes until you run it.</p>
            <div className="ai-prun">
              <button className="ai-b ai grow" ref={runBtn} onClick={approve}>
                Run
              </button>
              <button className="ai-b out" onClick={() => close(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="ai-pplan">
            <strong>Assistant</strong>
            <p className="ai-answer">{run.summary}</p>
            <div className="ai-prun">
              <button className="ai-b out grow" ref={answerBtn} onClick={() => close(false)}>
                Done
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  ) : null;

  // ---------- while it acts: the progress pill ----------
  const total = Math.max(run.plan.length, run.stepNo, 1);
  const pill =
    run.phase === "acting" ? (
      <div className={"ai-ui ai-pill" + (compact ? " phone" : "")} role="status" aria-live="polite">
        <I c={LoaderCircle} size={compact ? 18 : 14} className="ai-spin" style={{ color: "var(--ai)" }} />
        <span className="ai-ptext">{run.stepText || "Working on the canvas"}</span>
        {!compact ? <span className="ai-sub">{`${Math.min(run.stepNo, total)} of ${total}`}</span> : null}
        {!compact ? (
          <button className="ai-b out" aria-pressed={follow} title="Keep the assistant's work in view" onClick={() => setFollow((f) => !f)}>
            Follow
          </button>
        ) : null}
        <button className="ai-b out" onClick={() => run.runId && transport.cancel(run.runId)}>
          {!compact ? <I c={Square} size={14} /> : null}
          Stop
        </button>
      </div>
    ) : null;

  // ---------- review ----------
  const left = pending.length;
  const review =
    run.phase === "review" ? (
      <div className={"ai-ui ai-review" + (compact ? " phone" : "")} role="region" aria-label="Review the assistant's changes">
        {compact ? (
          <span className="ai-rt grow">{left > 0 ? `${left} suggestion${left === 1 ? "" : "s"} to review` : "All reviewed"}</span>
        ) : (
          <span className="ai-rt">
            <strong>{left > 0 ? `${left} suggestion${left === 1 ? "" : "s"} to review` : "All suggestions reviewed"}</strong>
            {run.summary ? <span className="ai-rsub"> · {run.summary}</span> : null}
            {run.error ? <span className="ai-rsub"> · {run.error}</span> : null}
          </span>
        )}
        {left > 0 && !compact ? (
          <>
            <button className="ai-b ib out" ref={reviewFirst} aria-label="Previous suggestion" onClick={() => setCursor(Math.max(0, cur - 1))}>
              <I c={ChevronLeft} />
            </button>
            <span className="ai-sub ai-count" aria-live="polite">{`${cur + 1} of ${left}`}</span>
            <button className="ai-b ib out" aria-label="Next suggestion" onClick={() => setCursor(Math.min(left - 1, cur + 1))}>
              <I c={ChevronRight} />
            </button>
          </>
        ) : null}
        {left > 0 && role === "edit" ? (
          <button className="ai-b ai" ref={compact ? reviewFirst : undefined} onClick={acceptAll}>
            Accept all
          </button>
        ) : null}
        <button className="ai-b out" ref={left > 0 ? undefined : reviewFirst} onClick={undoRun}>
          {!compact ? <I c={Undo2} size={14} /> : null}
          {compact ? "Undo" : "Undo run"}
        </button>
        {!compact || left === 0 ? (
          <button className="ai-b" onClick={finish}>
            Done
          </button>
        ) : null}
      </div>
    ) : null;

  return (
    <>
      {showSlot && desktopCard ? createPortal(desktopCard, slot) : null}
      {sheet}
      {pill}
      {review}
      <span className="ai-sr" aria-live="polite">
        {run.phase === "plan" ? "The assistant has a plan. Nothing changes until you run it." : run.phase === "review" ? `Done. ${left} suggestions to review.` : ""}
      </span>
    </>
  );
}

export const shortcutLabel = isMac ? "⌘J" : "Ctrl+J";
