// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// `#demo` only: a scripted assistant (no AI server, no model). It plays the approved prototype's
// run on the local doc and speaks the same protocol as the server (docs/15 §3.1): `ai-plan`, then
// after `ai-approve` `ai-step`s and `ai-done`. Like the server it writes with origin
// `ai:<runId>`, shows the agent in awareness (`user.id "ai:<runId>"`, `agent: true`,
// `cursor.blockId`), puts changes to existing text into the `suggestions` root, and `ai-undo`
// reverts only its own changes.
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { OcUser } from "@opencanvas/ui";
import { loadDatabase } from "../editor/blockdata";
import type { AiMsg, PlanStep } from "./model";
import { SUGGESTIONS } from "./suggestions";
import type { RunRequest, Transport } from "./transport";

/** Matches an instruction aimed at the assistant inside the content (treated as text, skipped). */
export const INJECTION = /^\s*(assistant|ai|claude|system)\s*[:,]|ignore (all |your |previous )*instructions/i;
const MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/;

export interface DemoTask {
  task: string;
  owner: string;
  due: string;
  line: string;
}

/** Turns note lines into tasks: owner from the people on the canvas, a due date, a short title. */
export function tasksFrom(lines: string[], people: OcUser[]): { tasks: DemoTask[]; injected: string[] } {
  const tasks: DemoTask[] = [];
  const injected: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (INJECTION.test(line)) {
      injected.push(line);
      continue;
    }
    const firsts = people.map((p) => ({ p, first: p.name.split(" ")[0] })).filter((x) => x.first.length > 1);
    const who = firsts.find((x) => new RegExp(`\\b${x.first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line));
    let owner = who ? who.p.name : "";
    if (!owner) {
      const m = /^([A-Z][a-z]+)\b/.exec(line) ?? /\(([A-Z][a-z]+)\)/.exec(line);
      if (m) owner = m[1];
    }
    const due = MONTH.exec(line);
    let task = line
      .replace(/\([^)]*\)/g, "")
      .replace(MONTH, "")
      .replace(/^[A-Z][a-z]+\s*(:|to|owns( the)?)\s*/i, "")
      .replace(/\s*(,|by)\s*$/i, "")
      .replace(/\s+(by|,)\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[,.]$/, "");
    if (!task) task = line;
    task = task[0].toUpperCase() + task.slice(1);
    tasks.push({ task, owner, due: due ? `${due[1]} ${due[2]}` : "", line });
  }
  return { tasks, injected };
}

interface Ctx {
  doc: Y.Doc;
  awareness: Awareness;
  me: OcUser;
  people: () => OcUser[];
  /** Tick length; tests pass 0. */
  tickMs?: number;
}

const AI_COLOR = "#7a45f0";

/** Text of a Y element (paragraphs, list items), for matching the selection's lines. */
function yText(el: Y.XmlElement | Y.XmlText): string {
  if (el instanceof Y.XmlText) return el.toString().replace(/<[^>]*>/g, "");
  return el.toArray().map((c) => (c instanceof Y.XmlElement || c instanceof Y.XmlText ? yText(c) : "")).join("");
}

/** The top-level element and the list items whose text matches the lines. */
function locate(frag: Y.XmlFragment, lines: string[]): { top: Y.XmlElement | null; items: Map<string, Y.XmlElement> } {
  const want = new Set(lines.map((l) => l.trim()));
  const items = new Map<string, Y.XmlElement>();
  let top: Y.XmlElement | null = null;
  const walk = (el: Y.XmlElement, root: Y.XmlElement) => {
    for (const c of el.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      if (c.nodeName === "listItem" || c.nodeName === "taskItem" || c.nodeName === "paragraph") {
        const t = yText(c).trim();
        if (want.has(t) && !items.has(t)) {
          items.set(t, c.nodeName === "paragraph" && (el.nodeName === "listItem" || el.nodeName === "taskItem") ? el : c);
          top = root;
          continue;
        }
      }
      walk(c, root);
    }
  };
  for (const c of frag.toArray()) if (c instanceof Y.XmlElement) {
    if (c.nodeName === "paragraph" && want.has(yText(c).trim())) {
      items.set(yText(c).trim(), c);
      top = c;
    } else walk(c, c);
  }
  return { top, items };
}

const bid = () => "b_" + Math.random().toString(36).slice(2, 10);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function demoTransport(ctx: Ctx): Transport {
  const subs = new Set<(m: AiMsg) => void>();
  const emit = (m: AiMsg) => subs.forEach((f) => f(m));
  const tick = ctx.tickMs ?? 650;
  const runs = new Map<string, { req: RunRequest; plan: PlanStep[]; tasks: DemoTask[]; cancelled: boolean; um: Y.UndoManager | null; agent: Awareness | null }>();

  const agentFor = (runId: string) => {
    const d = new Y.Doc();
    const aw = new Awareness(d);
    aw.setLocalState({ user: { id: `ai:${runId}`, name: "Assistant", color: AI_COLOR, onBehalfOf: ctx.me.id, onBehalfOfName: ctx.me.name }, agent: true, role: "edit" });
    const fwd = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) =>
      applyAwarenessUpdate(ctx.awareness, encodeAwarenessUpdate(aw, [...added, ...updated, ...removed]), "demo");
    aw.on("update", fwd);
    fwd({ added: [aw.clientID], updated: [], removed: [] });
    return aw;
  };
  const leave = (aw: Awareness | null) => {
    if (!aw) return;
    removeAwarenessStates(aw, [aw.clientID], "demo");
    aw.destroy();
  };

  async function act(runId: string) {
    const r = runs.get(runId);
    if (!r) return;
    const origin = `ai:${runId}`;
    const { doc } = ctx;
    const frag = doc.getXmlFragment("content");
    r.um = new Y.UndoManager([frag, doc.getMap("databases"), doc.getMap(SUGGESTIONS)], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    r.agent = agentFor(runId);
    const at = (blockId: string) => r.agent?.setLocalStateField("cursor", { blockId });
    const db = await loadDatabase();
    const { top, items } = locate(frag, r.req.selection.lines);
    let step = 0;
    const stepMsg = (tool: string, n: number, label: string) => emit({ t: "ai-step", runId, step: ++step, tool, ok: true, n, label });

    // 1. The database, right below the notes.
    let dbId = "";
    const dbBlock = bid();
    let rowValues: Record<string, unknown>[] = [];
    doc.transact(() => {
      const csv = ["Task,Owner,Due,Status", ...r.tasks.map((t) => [t.task, t.owner, t.due, "To do"].map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","))].join("\n");
      dbId = db.importCsvToDatabase(doc, csv, "Tasks", { users: ctx.people() });
      const m = db.getDbMap(doc, dbId)!;
      const snap = db.readDb(dbId, m);
      rowValues = snap.rows.map((row) => ({ ...(row as unknown as { v: Record<string, unknown> }).v }));
      m.set("icon", "database");
      m.set("tone", "purple");
      for (const row of snap.rows) db.deleteRow(doc, dbId, row.id);
      const el = new Y.XmlElement("database");
      el.setAttribute("dbId", dbId);
      el.setAttribute("blockId", dbBlock);
      const idx = top ? frag.toArray().indexOf(top) + 1 : frag.length;
      frag.insert(idx, [el]);
      // Ids on the notes, so the suggestions can address them.
      for (const it of items.values()) if (!it.getAttribute("blockId")) it.setAttribute("blockId", bid());
    }, origin);
    at(dbBlock);
    stepMsg("db_create", 1, "Adding the Tasks database");
    await wait(tick);

    // 2. One row at a time, owners matched to people on the canvas.
    for (const v of rowValues) {
      if (r.cancelled) break;
      doc.transact(() => db.addRow(doc, dbId, v as never), origin);
      stepMsg("db_upsert_rows", 2, "Adding rows from your notes");
      await wait(tick);
    }

    // 3. A suggested link from each note to its row (the person approves each).
    if (!r.cancelled) {
      at(top?.getAttribute("blockId") ?? [...items.values()][0]?.getAttribute("blockId") ?? dbBlock);
      if (top && !top.getAttribute("blockId")) doc.transact(() => top.setAttribute("blockId", bid()), origin);
      at(top?.getAttribute("blockId") ?? dbBlock);
      stepMsg("canvas_patch", 3, "Suggesting links on your notes");
      await wait(tick);
      doc.transact(() => {
        const root = doc.getMap(SUGGESTIONS);
        r.tasks.forEach((t, i) => {
          const el = items.get(t.line.trim());
          const blockId = el?.getAttribute("blockId");
          if (!blockId) return;
          const id = `sg_${runId}_${i}`;
          root.set(id, {
            id, by: ctx.me.id, name: "Assistant", origin, status: "pending", at: Date.now() + i,
            ops: [{ op: "editText", blockId, textEdits: [{ find: t.line.trim(), replace: `${t.line.trim()} [Tasks · row ${i + 1}](#block=${dbBlock})` }] }],
          });
        });
      }, origin);
      await wait(tick);
    }
    leave(r.agent);
    r.agent = null;
    const rows = r.cancelled ? Math.min(rowValues.length, step - 1) : rowValues.length;
    emit({
      t: "ai-done", runId, outcome: r.cancelled ? "cancelled" : "done",
      summary: `new Tasks database with ${rows} row${rows === 1 ? "" : "s"}`,
      steps: step, writes: step, undoable: true,
    });
  }

  return {
    demo: true,
    run(req) {
      const { tasks, injected } = tasksFrom(req.selection.lines, ctx.people());
      const n = tasks.length;
      const plan: PlanStep[] =
        req.mode === "answer"
          ? []
          : [
              { n: 1, text: "Add a database **Tasks** below these notes, with Task, Owner, Due and Status", kind: "create" },
              { n: 2, text: `Add ${n} row${n === 1 ? "" : "s"}, matching owners to people on this canvas`, kind: "create" },
              { n: 3, text: "Suggest a link from each note to its task. You approve each one.", kind: "suggest" },
            ];
      runs.set(req.runId, { req, plan, tasks, cancelled: false, um: null, agent: null });
      setTimeout(() => {
        // Reading the selection: the notes get block ids (the server reads them the same way).
        if (req.mode !== "answer" && n) {
          const frag = ctx.doc.getXmlFragment("content");
          const { top, items } = locate(frag, req.selection.lines);
          ctx.doc.transact(() => {
            for (const el of [top, ...items.values()]) if (el && !el.getAttribute("blockId")) el.setAttribute("blockId", bid());
          }, `ai-read:${req.runId}`);
        }
        if (req.mode === "answer" || !n) {
          const people = [...new Set(tasks.map((t) => t.owner).filter(Boolean))];
          emit({
            t: "ai-done", runId: req.runId, outcome: "done", writes: 0, steps: 1,
            summary: n ? `${n} action item${n === 1 ? "" : "s"}${people.length ? `, owned by ${people.join(", ")}` : ""}.` : "There's nothing in the selection the scripted demo can work with. Select the notes under “Notes from Monday” and try again.",
          });
          return;
        }
        emit({
          t: "ai-plan", runId: req.runId, plan,
          injected: injected.length
            ? `${injected.length === 1 ? "The last note asks" : `${injected.length} notes ask`} the assistant to ${/send|share|email/i.test(injected.join(" ")) ? "send this canvas to everyone" : "follow new instructions"}. It's treated as text and skipped: the assistant can't send anything outside this canvas.`
            : undefined,
        });
      }, Math.min(tick, 400));
    },
    approve(runId) {
      if (runs.has(runId)) void act(runId);
    },
    cancel(runId) {
      const r = runs.get(runId);
      if (r) r.cancelled = true;
    },
    undo(runId) {
      const r = runs.get(runId);
      if (!r?.um) return;
      while (r.um.undoStack.length) r.um.undo();
      r.um.destroy();
      r.um = null;
      emit({ t: "ai-done", runId, outcome: "undone", steps: 0, writes: 0, undoable: false });
    },
    on(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
