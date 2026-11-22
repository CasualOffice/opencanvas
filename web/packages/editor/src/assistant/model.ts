// The assistant's run state (docs/24 §10.2, approved prototype docs/prototypes/assistant-approved).
// Pure: no DOM, no Yjs. The UI renders it; the transports (server or the `#demo` script) feed it
// the same `ai-plan` / `ai-step` / `ai-done` messages (docs/15 §3.1).
import type { Role } from "@opencanvas/ui";

export type Mode = "edit" | "comment" | "answer";
export type StepKind = "create" | "update" | "suggest" | "read";
export interface PlanStep {
  n: number;
  text: string;
  kind: StepKind;
}

/** Server → client (docs/15 §3.1). Extra optional fields are tolerated. */
export type AiMsg =
  | { t: "ai-plan"; runId: string; plan: unknown; injected?: unknown; flags?: unknown }
  | { t: "ai-step"; runId: string; step: number; tool: string; ok: boolean; error?: string; label?: string; n?: number; flags?: unknown }
  | {
      t: "ai-done";
      runId: string;
      outcome: "done" | "cancelled" | "limit" | "error" | "refused" | "undone";
      summary?: string;
      reason?: string;
      steps?: number;
      writes?: number;
      undoable?: boolean;
      flags?: unknown;
    };

export const isAiMsg = (m: unknown): m is AiMsg =>
  !!m && typeof m === "object" && typeof (m as { t?: unknown }).t === "string" && /^ai-(plan|step|done)$/.test((m as { t: string }).t) && typeof (m as { runId?: unknown }).runId === "string";

export type SelKind = "lines" | "text" | "none";
export interface Selection {
  kind: SelKind;
  /** Top-level text of each selected line or block (plain text, never HTML). */
  lines: string[];
  blockIds: string[];
}

export interface Action {
  id: string;
  icon: string;
  label: string;
  prompt: string;
  mode: Mode;
  /** Shown after the label ("as suggestions"). */
  note?: string;
}

/** The four actions offered for a selection (prototype: Main.dc.html command bar). */
export function actionsFor(sel: Selection, role: Role): Action[] {
  const n = sel.lines.length;
  if (role === "comment") {
    return [
      { id: "summarise", icon: "align-left", label: sel.kind === "none" ? "Summarise this canvas" : "Summarise the selection", prompt: "Summarise", mode: "answer" },
      { id: "explain", icon: "message-square", label: "Explain this in plain words", prompt: "Explain this in plain words", mode: "answer" },
      { id: "questions", icon: "circle-help", label: "List the open questions", prompt: "List the open questions", mode: "answer" },
      { id: "risks", icon: "triangle-alert", label: "What could go wrong?", prompt: "What could go wrong?", mode: "answer" },
    ];
  }
  if (sel.kind === "lines")
    return [
      { id: "tasks", icon: "database", label: "Make a task database from these", prompt: "Make a task database from these", mode: "edit" },
      { id: "board", icon: "layout-dashboard", label: "Turn into a whiteboard, grouped by owner", prompt: "Turn into a whiteboard, grouped by owner", mode: "edit" },
      { id: "summarise", icon: "align-left", label: `Summarise for people who missed it`, prompt: "Summarise for people who missed it", mode: "edit" },
      { id: "rewrite", icon: "pen-line", label: "Rewrite more clearly", prompt: "Rewrite more clearly", mode: "edit", note: "as suggestions" },
    ].map((a) => (n === 1 && a.id === "tasks" ? { ...a, label: "Make a task from this" } : a)) as Action[];
  if (sel.kind === "text")
    return [
      { id: "rewrite", icon: "pen-line", label: "Rewrite more clearly", prompt: "Rewrite more clearly", mode: "edit", note: "as suggestions" },
      { id: "shorter", icon: "align-left", label: "Make it shorter", prompt: "Make it shorter", mode: "edit", note: "as suggestions" },
      { id: "tasks", icon: "list-todo", label: "Pull out the action items", prompt: "Pull out the action items", mode: "edit" },
      { id: "explain", icon: "message-square", label: "Explain this in plain words", prompt: "Explain this in plain words", mode: "answer" },
    ];
  return [
    { id: "summarise", icon: "align-left", label: "Summarise this canvas", prompt: "Summarise this canvas", mode: "answer" },
    { id: "tasks", icon: "database", label: "Make a task database from this canvas", prompt: "Make a task database from this canvas", mode: "edit" },
    { id: "questions", icon: "circle-help", label: "List the open questions", prompt: "List the open questions", mode: "answer" },
    { id: "next", icon: "list-todo", label: "Draft next steps", prompt: "Draft next steps", mode: "edit" },
  ];
}

export function placeholderFor(sel: Selection): string {
  if (sel.kind === "lines") return `What should the assistant do with ${sel.lines.length === 1 ? "this line" : `these ${sel.lines.length} lines`}?`;
  if (sel.kind === "text") return "What should the assistant do with the selection?";
  return "Ask about this canvas, or say what to do";
}

const KINDS = new Set<StepKind>(["create", "update", "suggest", "read"]);
/** `ai-plan.plan`: `[{n, text, kind}]`, or plain strings from an older server. Text only. */
export function parsePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s, i): PlanStep | null => {
      if (typeof s === "string") return { n: i + 1, text: s, kind: "update" };
      if (!s || typeof s !== "object") return null;
      const o = s as { n?: unknown; text?: unknown; kind?: unknown };
      if (typeof o.text !== "string" || !o.text.trim()) return null;
      return { n: typeof o.n === "number" ? o.n : i + 1, text: o.text, kind: KINDS.has(o.kind as StepKind) ? (o.kind as StepKind) : "update" };
    })
    .filter((s): s is PlanStep => !!s)
    .slice(0, 20);
}

/** What the pill says while a tool runs, when the server sends no label. */
export function toolLabel(tool: string): string {
  if (/^db_create/.test(tool)) return "Adding the database";
  if (/^db_/.test(tool)) return "Adding rows";
  if (/^board_/.test(tool)) return "Adding the whiteboard";
  if (/suggest/.test(tool)) return "Suggesting changes";
  if (/^comment/.test(tool)) return "Adding a comment";
  if (/read|list|search/.test(tool)) return "Reading the canvas";
  return "Working on the canvas";
}

export type Phase = "closed" | "bar" | "waiting" | "plan" | "acting" | "review" | "answer";
export interface RunState {
  phase: Phase;
  runId: string | null;
  prompt: string;
  mode: Mode;
  plan: PlanStep[];
  injected: string | null;
  stepText: string;
  /** Short form for the agent label on a block ("adding rows"). */
  stepShort: string;
  stepNo: number;
  summary: string;
  error: string | null;
}

export const initialRun: RunState = { phase: "closed", runId: null, prompt: "", mode: "edit", plan: [], injected: null, stepText: "", stepShort: "", stepNo: 0, summary: "", error: null };

export type RunEvent =
  | { e: "open" }
  | { e: "close" }
  | { e: "start"; runId: string; prompt: string; mode: Mode }
  | { e: "approve" }
  | { e: "msg"; m: AiMsg }
  | { e: "finish" };

const doneText: Record<string, string> = {
  cancelled: "Stopped. What was done so far stays until you undo it.",
  limit: "The assistant stopped at its limit for one run.",
  error: "Something went wrong on the AI server. Nothing more was changed.",
  refused: "The assistant can't do that here.",
};

/**
 * The plan note for server prompt-injection flags (`flags: [{blockId, kind, excerpt}]`,
 * docs/15 §3.1): content that reads like instructions to the assistant. Text only; the run is
 * never blocked by it.
 */
export function flagNote(flags: unknown): string | null {
  const n = Array.isArray(flags) ? flags.filter((f) => f && typeof f === "object" && (f as { kind?: unknown }).kind === "instruction_in_content").length : 0;
  if (!n) return null;
  return `${n === 1 ? "One part of this canvas reads" : `${n} parts of this canvas read`} like instructions to the assistant. It's treated as text, not followed: the assistant can't send anything outside this canvas.`;
}

/** The run state machine: closed → bar → waiting → plan → acting → review (or answer). */
export function reduce(s: RunState, ev: RunEvent): RunState {
  switch (ev.e) {
    case "open":
      return s.phase === "acting" || s.phase === "review" ? s : { ...initialRun, phase: "bar", prompt: s.phase === "plan" ? s.prompt : "" };
    case "close":
      return s.phase === "acting" || s.phase === "review" ? s : { ...initialRun };
    case "start":
      return { ...initialRun, phase: "waiting", runId: ev.runId, prompt: ev.prompt, mode: ev.mode };
    case "approve":
      return s.phase === "plan" ? { ...s, phase: "acting", stepNo: 1, stepText: s.plan[0]?.text ?? "Working on the canvas" } : s;
    case "finish":
      return { ...initialRun };
    case "msg": {
      const m = ev.m;
      if (m.runId !== s.runId) return s;
      if (m.t === "ai-plan") {
        const injected = typeof m.injected === "string" && m.injected.trim() ? m.injected : flagNote(m.flags);
        return { ...s, phase: "plan", plan: parsePlan(m.plan), injected };
      }
      if (m.t === "ai-step") {
        if (s.phase === "waiting" || s.phase === "plan") s = { ...s, phase: "acting" };
        if (s.phase !== "acting") return s;
        const n = typeof m.n === "number" ? m.n : s.stepNo || 1;
        return { ...s, stepNo: n, stepShort: toolLabel(m.tool), stepText: typeof m.label === "string" && m.label ? m.label : toolLabel(m.tool), error: m.ok ? s.error : (m.error ?? "internal") };
      }
      // ai-done
      if (m.outcome === "undone") return { ...initialRun };
      if (m.outcome === "cancelled" && m.reason === "plan_timeout") return { ...s, phase: "answer", summary: "The plan waited 10 minutes without a Run, so nothing was changed." };
      const summary = typeof m.summary === "string" ? m.summary : "";
      s = { ...s, injected: flagNote(m.flags) ?? s.injected };
      if (s.mode === "answer" || (m.outcome === "done" && !m.writes && summary))
        return { ...s, phase: "answer", summary: summary || doneText[m.outcome] || "" };
      if (m.outcome !== "done" && !m.writes) return { ...s, phase: "answer", summary: (summary ? summary + " " : "") + (doneText[m.outcome] ?? "") };
      return { ...s, phase: "review", summary, error: m.outcome === "done" ? null : (doneText[m.outcome] ?? null) };
    }
  }
}

/** Command bar keyboard: ↑/↓ move through the actions, ↵ runs the typed prompt or the active action, Esc closes. */
export function barKey(key: string, active: number, count: number, typed: string): { active: number; run?: "typed" | "action"; close?: boolean } {
  if (key === "ArrowDown") return { active: count ? (active + 1) % count : 0 };
  if (key === "ArrowUp") return { active: count ? (active - 1 + count) % count : 0 };
  if (key === "Home") return { active: 0 };
  if (key === "End") return { active: Math.max(0, count - 1) };
  if (key === "Enter") return { active, run: typed.trim() ? "typed" : "action" };
  if (key === "Escape") return { active, close: true };
  return { active };
}

export const newRunId = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
