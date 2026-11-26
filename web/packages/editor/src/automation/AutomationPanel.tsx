// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The automations panel (AUTO-06, approved prototype docs/prototypes/v03-approved/automation.html
// frames 1a-1b, 2a-2f, 4a-4d, 5a-5d, 6a-6c). Loaded when first opened. Rules are canvas data:
// saving writes the `automations` root (the server checks perms.automate, the owner, limits and
// origins again); test runs and the run history come from the server.
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import {
  ArrowLeft, Ban, Bolt, CalendarClock, Check, ChevronDown, CircleAlert, CircleCheck, CircleSlash, Clock, Database, FlaskConical, Globe, History,
  ListChecks, Lock, MessageSquare, Plus, Trash2, TriangleAlert, X, Zap,
} from "lucide-react";
import {
  actionParts, ago, blankRule, deleteRule, fieldOf, fmtNext, issues, nextRun, OPS, originAllowed, outcome, readChecklists, readDbs, readRules,
  setEnabled, suggestions, urlLabel, WEEKDAYS, whenParts, writeRule, type Action, type Condition, type Db, type Limits, type Part, type Rule, type Run, type Trigger,
} from "./model";
import "./automation.css";

export interface AutomationInfo {
  enabled: boolean;
  canEdit: boolean;
  history: boolean;
  limits: Limits;
}

export interface AutomationPanelProps {
  doc: Y.Doc;
  ticket: string;
  info: AutomationInfo;
  me: { id: string; name: string };
  hostName: string;
  compact: boolean;
  /** People by id, for names in sentences. */
  person(id: string): string;
  onClose(): void;
}

type View = { kind: "list" } | { kind: "edit"; rule: Rule; isNew: boolean } | { kind: "runs"; rule?: string } | { kind: "run"; run: Run };

function Words({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}> {p} </span>
        ) : (
          <span key={i} className={"tk" + (p.db ? " db" : "") + (p.mono ? " mono" : "") + (p.bad ? " bad" : "")}>
            {p.db ? <Database size={12} aria-hidden="true" /> : null}
            {p.tok}
          </span>
        ),
      )}
    </>
  );
}

function useRules(doc: Y.Doc) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const a = doc.getMap("automations");
    const d = doc.getMap("databases");
    a.observeDeep(bump);
    d.observeDeep(bump);
    return () => {
      a.unobserveDeep(bump);
      d.unobserveDeep(bump);
    };
  }, [doc]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ rules: readRules(doc), dbs: readDbs(doc), lists: readChecklists(doc) }), [doc, tick]);
}

function useRuns(ticket: string, on: boolean) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let off = false;
    const load = () =>
      fetch(`/v1/automations/runs?ticket=${encodeURIComponent(ticket)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { runs: [] }))
        .then((j: { runs?: Run[] }) => !off && setRuns(j.runs ?? []))
        .catch(() => !off && setRuns([]));
    void load();
    const t = window.setInterval(load, 15_000);
    return () => {
      off = true;
      window.clearInterval(t);
    };
  }, [ticket, on, n]);
  return { runs, reload: () => setN((x) => x + 1) };
}

export function AutomationPanel(p: AutomationPanelProps) {
  const { rules, dbs, lists } = useRules(p.doc);
  const { runs, reload } = useRuns(p.ticket, p.info.history);
  const [view, setView] = useState<View>({ kind: "list" });
  const lim = p.info.limits;
  const onCount = rules.filter((r) => r.enabled && !r.paused).length;
  const pausedCount = rules.filter((r) => r.paused).length;
  const full = rules.length >= lim.maxRules;
  const title = view.kind === "edit" ? "Edit rule" : view.kind === "runs" ? "Run history" : view.kind === "run" ? "Run details" : "Automations";

  let body: React.ReactNode;
  if (view.kind === "edit") {
    body = <Editor {...p} rule={view.rule} isNew={view.isNew} dbs={dbs} lists={lists} limits={lim} onDone={() => setView({ kind: "list" })} />;
  } else if (view.kind === "runs") {
    body = <Runs runs={runs} rules={rules} only={view.rule} onOpen={(run) => setView({ kind: "run", run })} />;
  } else if (view.kind === "run") {
    const rule = rules.find((r) => r.id === view.run.ruleId);
    body = <RunDetail run={view.run} rule={rule} dbs={dbs} lists={lists} person={p.person} hostName={p.hostName} onEdit={rule && p.info.canEdit ? () => setView({ kind: "edit", rule, isNew: false }) : undefined} />;
  } else {
    body = (
      <List
        {...p}
        rules={rules}
        dbs={dbs}
        lists={lists}
        runs={runs}
        full={full}
        onNew={(r) => setView({ kind: "edit", rule: r ?? blankRule(), isNew: true })}
        onEdit={(r) => setView({ kind: "edit", rule: r, isNew: false })}
        onRuns={(rule) => (reload(), setView({ kind: "runs", rule }))}
      />
    );
  }
  return (
    <aside className={"side ap" + (p.compact ? " ap-full" : "")} aria-label={title}>
      <div className="shd">
        {view.kind !== "list" ? (
          <button className="ib" aria-label="Back to automations" onClick={() => setView(view.kind === "run" ? { kind: "runs" } : { kind: "list" })}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        ) : (
          <span className="ap-ic" aria-hidden="true">
            <Zap size={15} />
          </span>
        )}
        <h2>
          {title}
          {view.kind === "list" && rules.length ? (
            <small>
              {rules.length} {rules.length === 1 ? "rule" : "rules"}
              {p.info.canEdit || p.info.history ? ` · ${onCount} on${pausedCount ? `, ${pausedCount} paused` : ""}` : ""}
            </small>
          ) : null}
        </h2>
        <span className="grow" />
        {view.kind === "list" && p.info.canEdit ? (
          <button className={"btn primary ap-new" + (p.compact ? " sm" : "")} disabled={full} title={full ? `This canvas has ${lim.maxRules} rules, the most it can have` : undefined} onClick={() => setView({ kind: "edit", rule: blankRule(), isNew: true })}>
            <Plus size={15} aria-hidden="true" />
            {p.compact ? "New" : "New rule"}
          </button>
        ) : null}
        <button className="ib" aria-label="Close automations" onClick={p.onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="sbd">{body}</div>
    </aside>
  );
}

// ---------- list (1a, 1b, 4c, 4d, 5a, 5c, 5d) ----------

function statusOf(r: Rule, runs: Run[] | null, tz: string): { cls: string; label: string; meta: string } {
  if (r.paused) {
    const code = r.paused.code;
    if (code === "FAILURES") return { cls: "bad", label: "Paused after 10 failed runs", meta: lastError(r, runs) };
    if (code === "OWNER_NO_EDIT") return { cls: "warn", label: `Paused: ${(r.ownerName ?? "its owner").split(" ")[0]} no longer has edit access`, meta: r.paused.at ? `Since ${new Date(r.paused.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : "" };
    if (code === "STALE_OWNER") return { cls: "warn", label: "Paused: its owner has not opened this canvas for 30 days", meta: "" };
    return { cls: "bad", label: "Paused until fixed", meta: "It points at something that no longer exists" };
  }
  if (!r.enabled) return { cls: "off", label: "Off", meta: r.updatedAt ? `Off since ${new Date(r.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "" };
  const next = nextRun(r.trigger, r.timeZone ?? tz);
  if (next) return { cls: "on", label: "On", meta: fmtNext(next, r.timeZone ?? tz) };
  const mine = (runs ?? []).filter((x) => x.ruleId === r.id && x.result !== "running");
  const week = mine.filter((x) => x.at > Date.now() - 7 * 86_400_000).length;
  return { cls: "on", label: "On", meta: mine.length ? `Ran ${ago(mine[0].at)} · ${week} ${week === 1 ? "run" : "runs"} this week` : runs ? "Not run yet" : "" };
}

function lastError(r: Rule, runs: Run[] | null): string {
  const f = (runs ?? []).find((x) => x.ruleId === r.id && x.result === "failed");
  return f ? `Last error: ${f.httpStatus ? `${f.httpStatus} from the URL` : outcome(f).split(" · ")[0]}` : "";
}

function List(p: AutomationPanelProps & { rules: Rule[]; dbs: Db[]; lists: { id: string; text: string }[]; runs: Run[] | null; full: boolean; onNew(r?: Rule): void; onEdit(r: Rule): void; onRuns(rule?: string): void }) {
  const tz = p.info.limits.timeZone;
  if (!p.rules.length) {
    if (!p.info.canEdit) {
      return (
        <div className="ap-empty">
          <span className="ap-big" aria-hidden="true"><Zap size={22} /></span>
          <h3>No automations here</h3>
          <p>{p.info.enabled ? "Editors who may automate can add rules that run on their own." : `${p.hostName} doesn’t run automations.`}</p>
        </div>
      );
    }
    const sug = suggestions(p.dbs, p.lists.length > 0);
    return (
      <>
        <div className="ap-empty">
          <span className="ap-big" aria-hidden="true"><Zap size={22} /></span>
          <h3>Let this canvas do the busywork</h3>
          <p>Rules run on their own when something changes here, on a date, or on a schedule. They change only this canvas and notify people through {p.hostName}.</p>
        </div>
        <div className="ap-cap">Suggested for this canvas</div>
        {sug.map((s) => (
          <button key={s.title} className="ap-sug" onClick={() => p.onNew({ ...s.rule })}>
            {s.where === "Schedule" ? <CalendarClock size={18} aria-hidden="true" /> : <Zap size={18} aria-hidden="true" />}
            <span className="ap-sug-t"><b>{s.title}</b><span>{s.where}</span></span>
          </button>
        ))}
        <button className="ap-sug ap-scratch" onClick={() => p.onNew()}>
          <Plus size={18} aria-hidden="true" />
          <span className="ap-sug-t"><b>Start from scratch</b></span>
        </button>
      </>
    );
  }
  const ownerLost = p.rules.find((r) => r.paused?.code === "OWNER_NO_EDIT" || r.paused?.code === "STALE_OWNER");
  const failed = p.rules.find((r) => r.paused?.code === "FAILURES");
  return (
    <>
      {p.info.canEdit && ownerLost ? (
        <div className="ap-ban warn" role="status">
          <TriangleAlert size={16} aria-hidden="true" />
          <span><b>{ownerLost.name}</b> is paused. It runs as {ownerLost.ownerName ?? "its owner"}, who no longer has edit access to this canvas.</span>
          <button className="btn sm" onClick={() => setEnabled(p.doc, ownerLost.id, true, p.me)}>Run it as me</button>
        </div>
      ) : null}
      {p.info.history && failed ? (
        <div className="ap-ban bad" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span><b>{failed.name}</b> failed 10 times in a row and was paused.</span>
          <button className="ap-link" onClick={() => p.onRuns(failed.id)}>See the runs</button>
        </div>
      ) : null}
      {p.rules.map((r) => {
        const st = statusOf(r, p.runs, tz);
        const db = r.trigger && "database" in r.trigger ? p.dbs.find((d) => d.id === (r.trigger as { database: string }).database) : undefined;
        const then = r.actions.flatMap((a, i) => [...(i ? [", "] : []), ...actionParts(a, db, p.dbs, p.person)]);
        return (
          <div key={r.id} className={"ar" + (st.cls === "bad" ? " ar-bad" : "") + (st.cls === "off" ? " dim" : "")}>
            <div className="ar-h">
              <span className="ar-t">{r.name || "Untitled rule"}</span>
              {p.info.canEdit ? (
                <>
                  <label className="ap-sw" title={r.enabled ? "Switch off" : "Switch on (runs as you)"}>
                    <input type="checkbox" role="switch" checked={r.enabled && !r.paused} aria-label={`${r.name || "Rule"} on`} onChange={(e) => setEnabled(p.doc, r.id, e.target.checked, p.me)} />
                    <span aria-hidden="true" />
                  </label>
                  <button className="ib sm" aria-label={`Edit ${r.name || "rule"}`} onClick={() => p.onEdit(r)}>
                    <ChevronDown size={15} aria-hidden="true" className="rot270" />
                  </button>
                </>
              ) : null}
            </div>
            <div className="ar-s"><span className="ar-k">When</span><Words parts={whenParts(r.trigger, p.dbs, p.lists)} /></div>
            <div className="ar-s"><span className="ar-k">Then</span><Words parts={then} /></div>
            <div className="ar-m">
              <span className={"ar-st " + st.cls}>{st.cls === "on" ? <CircleCheck size={12} aria-hidden="true" /> : st.cls === "off" ? <CircleSlash size={12} aria-hidden="true" /> : <Ban size={12} aria-hidden="true" />}{st.label}</span>
              {st.meta ? <span>{st.meta}</span> : null}
            </div>
          </div>
        );
      })}
      {p.info.canEdit && p.full ? (
        <p className="ap-fine"><Lock size={14} aria-hidden="true" />This canvas has {p.info.limits.maxRules} rules, the most it can have. Delete one to add another.</p>
      ) : null}
      {!p.info.canEdit ? (
        <p className="ap-fine"><Lock size={14} aria-hidden="true" />{p.info.history ? `${p.hostName} hasn’t let you create automations. You can still see what runs here.` : "You can view this canvas. Editors manage its rules."}</p>
      ) : null}
      <div className="ap-f">
        {p.info.history ? (
          <button className="ap-link" onClick={() => p.onRuns()}>
            <History size={15} aria-hidden="true" />
            Run history
          </button>
        ) : null}
        <span className="grow" />
        <span>Runs as the person who last edited the rule</span>
      </div>
    </>
  );
}

// ---------- editor (2a-2f) ----------

const TRIGGERS: { group: string; items: { kind: Trigger["kind"] | "schedule-minutes"; label: string; needs?: "db" | "list" }[] }[] = [
  { group: "In a database", items: [{ kind: "row.added", label: "A row is added", needs: "db" }, { kind: "field.changed", label: "A field changes", needs: "db" }, { kind: "date.reached", label: "A date is reached", needs: "db" }] },
  { group: "In the canvas", items: [{ kind: "checklist.checked", label: "A checklist item is checked", needs: "list" }, { kind: "comment.added", label: "A comment or mention is added" }] },
  { group: "On a schedule", items: [{ kind: "schedule", label: "Every day, week or month" }, { kind: "schedule-minutes", label: "Every 15 minutes or more" }] },
];

const ACTIONS: { kind: Action["kind"]; label: string; needsRow?: boolean }[] = [
  { kind: "field.set", label: "Set a field", needsRow: true },
  { kind: "row.move", label: "Move the row", needsRow: true },
  { kind: "todo.set", label: "Check or uncheck the item" },
  { kind: "todo.add", label: "Add a checklist" },
  { kind: "comment.add", label: "Add a comment" },
  { kind: "notify", label: "Notify people" },
  { kind: "http.post", label: "Call a URL" },
];

function triggerFor(kind: string, dbs: Db[]): Trigger {
  const db = dbs[0];
  const status = db?.fields.find((f) => f.type === "status" || f.type === "select") ?? db?.fields[0];
  const date = db?.fields.find((f) => f.type === "date") ?? db?.fields[0];
  switch (kind) {
    case "row.added":
      return { kind: "row.added", database: db?.id ?? "" };
    case "field.changed":
      return { kind: "field.changed", database: db?.id ?? "", field: status?.id ?? "", to: status?.options.at(-1) };
    case "date.reached":
      return { kind: "date.reached", database: db?.id ?? "", field: date?.id ?? "", offsetDays: -1, time: "09:00" };
    case "checklist.checked":
      return { kind: "checklist.checked" };
    case "comment.added":
      return { kind: "comment.added" };
    case "schedule-minutes":
      return { kind: "schedule", every: "minutes", minutes: 15 };
    default:
      return { kind: "schedule", every: "week", weekday: 1, time: "09:00" };
  }
}

function actionFor(kind: Action["kind"], db: Db | undefined, dbs: Db[], origins: string[]): Action {
  switch (kind) {
    case "field.set":
      return { kind, field: db?.fields[1]?.id ?? "", value: "" };
    case "row.move":
      return { kind, to: { database: dbs.find((d) => d.id !== db?.id)?.id ?? "" } };
    case "todo.set":
      return { kind, checked: true };
    case "todo.add":
      return { kind, heading: "", items: [""] };
    case "comment.add":
      return { kind, text: "" };
    case "notify": {
      const person = db?.fields.find((f) => f.type === "person");
      return { kind, people: person ? [`field:${person.id}`] : [], text: "{row.title}" };
    }
    case "http.post":
      return { kind, url: origins[0] ? `${origins[0]}/` : "https://", fields: [] };
  }
}

function Editor(p: AutomationPanelProps & { rule: Rule; isNew: boolean; dbs: Db[]; lists: { id: string; text: string }[]; limits: Limits; onDone(): void }) {
  const [r, setR] = useState<Rule>(() => structuredClone(p.rule));
  const [picker, setPicker] = useState(!p.rule.trigger);
  const [addAct, setAddAct] = useState(false);
  const [test, setTest] = useState<null | "busy" | Record<string, unknown>>(null);
  const [showErr, setShowErr] = useState(false);
  const t = r.trigger;
  const db = t && "database" in t ? p.dbs.find((d) => d.id === t.database) : undefined;
  const errs = issues(r, p.dbs, p.limits);
  const set = (patch: Partial<Rule>) => setR((x) => ({ ...x, ...patch }));
  const setT = (patch: Partial<Trigger>) => set({ trigger: { ...(r.trigger as Trigger), ...patch } as Trigger });
  const setA = (i: number, patch: Partial<Action>) => set({ actions: r.actions.map((a, j) => (j === i ? ({ ...a, ...patch } as Action) : a)) });
  const setC = (i: number, patch: Partial<Condition>) => set({ conditions: r.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const takesOver = !p.isNew && r.ownerId && r.ownerId !== p.me.id;

  const save = () => {
    setShowErr(true);
    if (errs.length) return;
    writeRule(p.doc, { ...r, name: r.name.trim() || "New rule" }, p.me);
    p.onDone();
  };
  const runTest = async () => {
    setTest("busy");
    try {
      const res = await fetch(`/v1/automations/test?ticket=${encodeURIComponent(p.ticket)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: { ...r, v: 1, ownerId: p.me.id, enabled: true } }),
      });
      setTest((await res.json()) as Record<string, unknown>);
    } catch {
      setTest({ error: "The test run did not reach the server. Try again." });
    }
  };
  const fieldSel = (value: string, onChange: (v: string) => void, label: string, filter?: (f: Db["fields"][number]) => boolean) => (
    <select className="tk pick" aria-label={label} value={fieldOf(db, value)?.id ?? value} onChange={(e) => onChange(e.target.value)}>
      {!fieldOf(db, value) ? <option value={value}>{value || "Choose a field"}</option> : null}
      {(db?.fields ?? []).filter((f) => !filter || filter(f)).map((f) => (
        <option key={f.id} value={f.id}>{f.name}</option>
      ))}
    </select>
  );
  const dbSel = (value: string, onChange: (v: string) => void, label: string, except?: string) => (
    <select className="tk pick db" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!p.dbs.some((d) => d.id === value) ? <option value={value}>{value ? "A deleted database" : "Choose a database"}</option> : null}
      {p.dbs.filter((d) => d.id !== except).map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
  const time = (v: string | undefined, onChange: (v: string) => void) => <input className="tk pick" type="time" aria-label="Time" value={v ?? "09:00"} onChange={(e) => onChange(e.target.value)} />;

  let when: React.ReactNode = null;
  if (t) {
    switch (t.kind) {
      case "row.added":
        when = <>A row is added to {dbSel(t.database, (v) => setT({ database: v }), "Database")}</>;
        break;
      case "field.changed": {
        const f = fieldOf(db, t.field);
        when = (
          <>
            {fieldSel(t.field, (v) => setT({ field: v, to: undefined }), "Field")} changes to{" "}
            {f?.options.length ? (
              <select className="tk pick" aria-label="Value" value={t.to == null ? "" : String(t.to)} onChange={(e) => setT({ to: e.target.value || undefined })}>
                <option value="">Any value</option>
                {!f.options.includes(String(t.to ?? "")) && t.to ? <option value={String(t.to)}>{String(t.to)}</option> : null}
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input className="tk pick" aria-label="Value" placeholder="any value" value={t.to == null ? "" : String(t.to)} onChange={(e) => setT({ to: e.target.value || undefined })} />
            )}{" "}
            in {dbSel(t.database, (v) => setT({ database: v }), "Database")}
          </>
        );
        break;
      }
      case "date.reached":
        when = (
          <>
            {fieldSel(t.field, (v) => setT({ field: v }), "Date field", (f) => f.type === "date")} is{" "}
            <select className="tk pick" aria-label="When" value={t.offsetDays} onChange={(e) => setT({ offsetDays: +e.target.value })}>
              {[-7, -3, -2, -1, 0, 1].map((n) => <option key={n} value={n}>{n === 0 ? "today" : n < 0 ? `${-n} ${n === -1 ? "day" : "days"} away` : `${n} day ago`}</option>)}
            </select>
            , at {time(t.time, (v) => setT({ time: v }))} in {dbSel(t.database, (v) => setT({ database: v }), "Database")}
          </>
        );
        break;
      case "checklist.checked":
        when = (
          <>
            <select className="tk pick" aria-label="Checklist item" value={t.block ?? ""} onChange={(e) => setT({ block: e.target.value || undefined })}>
              <option value="">Any checklist item</option>
              {p.lists.map((l) => <option key={l.id} value={l.id}>{l.text || "Item"}</option>)}
            </select>{" "}
            is checked
          </>
        );
        break;
      case "comment.added":
      case "mention.added":
        when = (
          <select className="tk pick" aria-label="Comment trigger" value={t.kind} onChange={(e) => set({ trigger: { kind: e.target.value as "comment.added" } })}>
            <option value="comment.added">A comment is added</option>
            <option value="mention.added">Someone is mentioned in a comment</option>
          </select>
        );
        break;
      case "schedule":
        when =
          t.every === "minutes" ? (
            <>
              Every <input className="tk pick num" type="number" min={p.limits.minIntervalMin} step={5} aria-label="Minutes" value={t.minutes ?? 15} onChange={(e) => setT({ minutes: +e.target.value })} /> minutes
            </>
          ) : (
            <>
              Every{" "}
              <select className="tk pick" aria-label="Repeat" value={t.every} onChange={(e) => setT({ every: e.target.value as "day" })}>
                <option value="day">day</option>
                <option value="week">week, on</option>
                <option value="month">month, on day</option>
              </select>{" "}
              {t.every === "week" ? (
                <select className="tk pick" aria-label="Weekday" value={t.weekday ?? 1} onChange={(e) => setT({ weekday: +e.target.value })}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              ) : t.every === "month" ? (
                <input className="tk pick num" type="number" min={1} max={28} aria-label="Day of the month" value={t.monthday ?? 1} onChange={(e) => setT({ monthday: +e.target.value })} />
              ) : null}{" "}
              at {time(t.time, (v) => setT({ time: v }))}
            </>
          );
        break;
    }
  }

  return (
    <div className="re">
      {test && test !== "busy" ? <TestResult result={test} hostName={p.hostName} onClose={() => setTest(null)} /> : null}
      {takesOver ? <p className="ap-fine"><Bolt size={14} aria-hidden="true" />Saving makes you its owner: it runs as you from now on.</p> : null}
      <label className="re-name">
        <span className="re-k">Name</span>
        <input value={r.name} placeholder="New rule" maxLength={120} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <div className={"re-s" + (picker ? " on" : "")}>
        <div className="re-k"><Clock size={13} aria-hidden="true" />When</div>
        {t && !picker ? (
          <div className="re-c">
            {when}
            <button className="ib sm" aria-label="Change the trigger" onClick={() => setPicker(true)}><ChevronDown size={14} aria-hidden="true" /></button>
          </div>
        ) : (
          <div className="re-pick" role="listbox" aria-label="Choose a trigger">
            {TRIGGERS.map((g) => (
              <div key={g.group}>
                <div className="re-g">{g.group}</div>
                {g.items.map((it) => {
                  const missing = it.needs === "db" && !p.dbs.length ? "This canvas has no database" : it.needs === "list" && !p.lists.length ? "This canvas has no checklist" : "";
                  return (
                    <button key={it.label} role="option" aria-selected={false} className="re-opt" disabled={!!missing} title={missing || undefined} onClick={() => (set({ trigger: triggerFor(it.kind, p.dbs) }), setPicker(false))}>
                      {it.label}
                      {missing ? <span>{missing}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="re-s">
        <div className="re-k"><ListChecks size={13} aria-hidden="true" />Only if</div>
        {r.conditions.map((c, i) => (
          <div className="re-c" key={i}>
            <span className="re-and">{i ? (r.match === "any" ? "or" : "and") : ""}</span>
            {db ? fieldSel(c.field, (v) => setC(i, { field: v }), "Condition field") : <span className="tk">{c.field}</span>}
            <select className="tk pick" aria-label="Condition" value={c.op} onChange={(e) => setC(i, { op: e.target.value })}>
              {OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {!["isEmpty", "isNotEmpty"].includes(c.op) ? <input className="tk pick" aria-label="Condition value" value={c.value == null ? "" : String(c.value)} onChange={(e) => setC(i, { value: e.target.value })} /> : null}
            <button className="ib sm" aria-label="Remove the condition" onClick={() => set({ conditions: r.conditions.filter((_, j) => j !== i) })}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        ))}
        <div className="re-c">
          {db ? (
            <button className="re-add" disabled={r.conditions.length >= 10} onClick={() => set({ conditions: [...r.conditions, { field: db.fields[1]?.id ?? db.fields[0]?.id ?? "", op: "isNotEmpty" }] })}>
              <Plus size={14} aria-hidden="true" />Add a condition
            </button>
          ) : (
            <span className="re-sub">Conditions look at the row of a database trigger.</span>
          )}
          {r.conditions.length > 1 ? (
            <select className="tk pick" aria-label="Match" value={r.match ?? "all"} onChange={(e) => set({ match: e.target.value as "all" })}>
              <option value="all">all of these</option>
              <option value="any">any of these</option>
            </select>
          ) : null}
        </div>
      </div>
      <div className="re-s">
        <div className="re-k"><Zap size={13} aria-hidden="true" />Then</div>
        {r.actions.map((a, i) => (
          <ActionRow key={i} a={a} db={db} dbs={p.dbs} limits={p.limits} hostName={p.hostName} fieldSel={fieldSel} dbSel={dbSel} onChange={(x) => setA(i, x)} onRemove={() => set({ actions: r.actions.filter((_, j) => j !== i) })} />
        ))}
        {r.actions.length < 5 ? (
          addAct ? (
            <div className="re-pick" role="listbox" aria-label="Add an action">
              {ACTIONS.filter((x) => p.limits.actions.includes(x.kind)).map((x) => (
                <button key={x.kind} role="option" aria-selected={false} className="re-opt" disabled={!!x.needsRow && !db} title={x.needsRow && !db ? "Needs a trigger in a database" : undefined} onClick={() => (set({ actions: [...r.actions, actionFor(x.kind, db, p.dbs, p.limits.origins)] }), setAddAct(false))}>
                  {x.label}
                </button>
              ))}
            </div>
          ) : (
            <button className="re-add" onClick={() => setAddAct(true)}><Plus size={14} aria-hidden="true" />Add an action</button>
          )
        ) : null}
      </div>
      {showErr && errs.length ? (
        <div className="re-errs" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <div>
            <b>{errs.length === 1 ? "1 thing" : `${errs.length} things`} to fix before this rule can run</b>
            <ul>{errs.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        </div>
      ) : null}
      <div className="re-f">
        <button className="btn" onClick={runTest} disabled={test === "busy" || !r.trigger || !r.actions.length}>
          <FlaskConical size={15} aria-hidden="true" />
          {test === "busy" ? "Testing…" : "Test run"}
        </button>
        <span className="grow" />
        {!p.isNew ? (
          <button className="ib" aria-label="Delete the rule" title="Delete the rule" onClick={() => (deleteRule(p.doc, r.id), p.onDone())}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        ) : null}
        <button className="btn" onClick={p.onDone}>Cancel</button>
        <button className="btn primary" onClick={save}>Save rule</button>
      </div>
    </div>
  );
}

function ActionRow(p: {
  a: Action;
  db: Db | undefined;
  dbs: Db[];
  limits: Limits;
  hostName: string;
  fieldSel(value: string, onChange: (v: string) => void, label: string, filter?: (f: Db["fields"][number]) => boolean): React.ReactNode;
  dbSel(value: string, onChange: (v: string) => void, label: string, except?: string): React.ReactNode;
  onChange(x: Partial<Action>): void;
  onRemove(): void;
}) {
  const { a, db } = p;
  let row: React.ReactNode;
  let bad = false;
  let after: React.ReactNode = null;
  switch (a.kind) {
    case "field.set":
      row = <>Set {p.fieldSel(a.field, (v) => p.onChange({ field: v }), "Field to set")} to <input className="tk pick" aria-label="New value" placeholder="today, a value…" value={a.value == null ? "" : String(a.value)} onChange={(e) => p.onChange({ value: e.target.value })} /></>;
      break;
    case "row.move":
      row = <>Move the row to {p.dbSel(a.to.database, (v) => p.onChange({ to: { database: v } }), "Target database", db?.id)}</>;
      bad = !p.dbs.some((d) => d.id === a.to.database);
      break;
    case "todo.set":
      row = (
        <select className="tk pick" aria-label="Check or uncheck" value={a.checked ? "1" : "0"} onChange={(e) => p.onChange({ checked: e.target.value === "1" })}>
          <option value="1">Check the item</option>
          <option value="0">Uncheck the item</option>
        </select>
      );
      break;
    case "todo.add":
      row = (
        <span className="re-col">
          Add the checklist <input className="tk pick" aria-label="Checklist heading" placeholder="Heading" value={a.heading ?? ""} onChange={(e) => p.onChange({ heading: e.target.value })} />
          <textarea aria-label="Checklist items, one per line" rows={3} placeholder="One item per line" value={a.items.join("\n")} onChange={(e) => p.onChange({ items: e.target.value.split("\n") })} />
        </span>
      );
      break;
    case "comment.add":
      row = <>Comment <input className="tk pick wide" aria-label="Comment text" placeholder="{row.title} is blocked" value={a.text} onChange={(e) => p.onChange({ text: e.target.value })} /></>;
      break;
    case "notify": {
      const persons = (db?.fields ?? []).filter((f) => f.type === "person");
      row = (
        <span className="re-col">
          <span>
            Notify{" "}
            <select className="tk pick" aria-label="Who to notify" value={a.people[0] ?? ""} onChange={(e) => p.onChange({ people: e.target.value ? [e.target.value] : [] })}>
              <option value="">Choose who</option>
              {persons.map((f) => <option key={f.id} value={`field:${f.id}`}>{f.name}</option>)}
              <option value="actor">the person who made the change</option>
            </select>
          </span>
          <input className="tk pick wide" aria-label="Message" value={a.text} onChange={(e) => p.onChange({ text: e.target.value })} />
          <span className="re-sub">Through {p.hostName}; OpenCanvas sends no mail. Use {"{row.title}"} or {"{field.Status}"} for the row’s values.</span>
        </span>
      );
      break;
    }
    case "http.post": {
      bad = !originAllowed(a.url, p.limits.origins);
      const fields = db?.fields ?? [];
      after = (
        <>
          {bad ? (
            <div className="re-e" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>This URL isn’t allowed. Automations here may call {p.limits.origins.map((o) => <span key={o} className="tk mono">{new URL(o).host}</span>)}. Ask your {p.hostName} admin to add another.</span></div>
          ) : null}
          {fields.length ? (
            <div className="re-c re-send">
              Send:{" "}
              {fields.map((f) => (
                <label key={f.id} className="re-chk">
                  <input type="checkbox" checked={a.fields.includes(f.name)} onChange={(e) => p.onChange({ fields: e.target.checked ? [...a.fields, f.name] : a.fields.filter((x) => x !== f.name) })} />
                  {f.name}
                </label>
              ))}
            </div>
          ) : null}
          <div className="re-sub">
            {a.fields.length ? `Sends the row’s ${a.fields.join(" and ")} to ${urlLabel(a.url).split("/")[0]}. ` : ""}Anyone who can read this canvas can read this rule: never put a secret in a URL.
          </div>
        </>
      );
      row = <>Call a URL <input className={"tk pick wide mono" + (bad ? " bad" : "")} aria-label="URL" aria-invalid={bad} value={a.url} onChange={(e) => p.onChange({ url: e.target.value })} /></>;
      break;
    }
  }
  const icon = a.kind === "http.post" ? <Globe size={15} aria-hidden="true" /> : a.kind === "notify" || a.kind === "comment.add" ? <MessageSquare size={15} aria-hidden="true" /> : a.kind === "row.move" ? <Database size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />;
  return (
    <div className={"re-a" + (bad ? " err" : "")}>
      {icon}
      <div className="re-ab">
        <div className="re-c">{row}</div>
        {after}
      </div>
      <button className="ib sm" aria-label="Remove the action" onClick={p.onRemove}><Trash2 size={14} aria-hidden="true" /></button>
    </div>
  );
}

function TestResult(p: { result: Record<string, unknown>; hostName: string; onClose(): void }) {
  const r = p.result as { error?: string; subject?: { title?: string }; trigger?: string; conditions?: { field: string; op: string; holds: boolean }[]; conditionsHold?: boolean; effects?: string[] };
  return (
    <div className="re-test" role="status">
      <div className="re-test-h">
        <FlaskConical size={16} aria-hidden="true" />
        <b>{r.error ? "Test run" : `Test run on “${r.subject?.title || "the canvas"}”`}</b>
        <span className="grow" />
        <button className="ib sm" aria-label="Close the test run" onClick={p.onClose}><X size={14} aria-hidden="true" /></button>
      </div>
      {r.error ? (
        <div className="re-e"><CircleAlert size={14} aria-hidden="true" /><span>{r.error}</span></div>
      ) : (
        <ul>
          <li><CircleCheck size={14} aria-hidden="true" />Trigger matches</li>
          {(r.conditions ?? []).map((c, i) => (
            <li key={i} className={c.holds ? "" : "no"}>{c.holds ? <CircleCheck size={14} aria-hidden="true" /> : <CircleSlash size={14} aria-hidden="true" />}{c.field} {OPS.find((o) => o[0] === c.op)?.[1] ?? c.op}: {c.holds ? "holds" : "does not hold"}</li>
          ))}
          {r.conditionsHold === false ? <li className="no"><CircleSlash size={14} aria-hidden="true" />This run would be skipped</li> : (r.effects ?? []).map((e) => <li key={e}><Zap size={14} aria-hidden="true" />{e.replace("through the host", `through ${p.hostName}`)}</li>)}
        </ul>
      )}
      <p className="re-sub">Nothing was changed or sent.</p>
    </div>
  );
}

// ---------- runs (4a, 4b, 6c) ----------

function runIcon(r: Run) {
  if (r.result === "done") return <span className="rr-i done" role="img" aria-label="Done"><CircleCheck size={14} /></span>;
  if (r.result === "failed") return <span className="rr-i failed" role="img" aria-label="Failed"><CircleAlert size={14} /></span>;
  if (r.result === "stopped") return <span className="rr-i stopped" role="img" aria-label="Stopped"><Ban size={14} /></span>;
  return <span className="rr-i skipped" role="img" aria-label="Skipped"><CircleSlash size={14} /></span>;
}

const TRIGGER_WORDS: Record<string, string> = {
  "row.added": "A row was added",
  "field.changed": "A field changed",
  "checklist.checked": "An item was checked",
  "comment.added": "A comment was added",
  "mention.added": "Someone was mentioned",
  "date.reached": "A date was reached",
  schedule: "Schedule",
};

function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const t = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (d.toDateString() === today.toDateString()) return `Today ${t}`;
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return `Yesterday ${t}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${t}`;
}

function Runs(p: { runs: Run[] | null; rules: Rule[]; only?: string; onOpen(r: Run): void }) {
  const [filter, setFilter] = useState<"all" | "failed" | "stopped">("all");
  const name = (id: string) => p.rules.find((r) => r.id === id)?.name || "A deleted rule";
  const list = (p.runs ?? []).filter((r) => r.result !== "running" && (!p.only || r.ruleId === p.only) && (filter === "all" || r.result === filter));
  return (
    <>
      <div className="ap-bar" role="radiogroup" aria-label="Show">
        {(["all", "failed", "stopped"] as const).map((f) => (
          <button key={f} role="radio" aria-checked={filter === f} className={"sa-chip ap-chip" + (filter === f ? " on" : "")} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "failed" ? "Failed" : "Stopped"}
          </button>
        ))}
        <span className="grow" />
        <span className="ap-30">Last 30 days</span>
      </div>
      {p.runs === null ? <p className="ap-fine">Loading…</p> : null}
      {p.runs && !list.length ? <p className="ap-fine">No runs{filter === "all" ? " yet" : ` ${filter}`}.</p> : null}
      <ul className="rr-list">
        {list.map((r) => (
          <li key={r.id}>
            <button className="rr" onClick={() => p.onOpen(r)}>
              {runIcon(r)}
              <span className="rr-b">
                <span className="rr-t"><b>{name(r.ruleId)}</b><span>{when(r.at)}</span></span>
                <span className="rr-r">{TRIGGER_WORDS[r.trigger] ?? r.trigger}{r.depth ? ` · rule ${r.depth + 1} in a chain` : ""}</span>
                <span className="rr-d">{outcome(r)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="ap-fine"><Lock size={14} aria-hidden="true" />Runs keep ids, times and results only, never canvas text. Kept 30 days.</p>
    </>
  );
}

function RunDetail(p: { run: Run; rule?: Rule; dbs: Db[]; lists: { id: string; text: string }[]; person(id: string): string; hostName: string; onEdit?: () => void }) {
  const r = p.run;
  const label = r.result === "done" ? "Done" : r.result === "failed" ? "Failed" : r.result === "stopped" ? "Stopped" : "Skipped";
  const db = p.rule?.trigger && "database" in p.rule.trigger ? p.dbs.find((d) => d.id === (p.rule!.trigger as { database: string }).database) : undefined;
  return (
    <>
      <div className="rd-h">
        {runIcon(r)}
        <span><b>{p.rule?.name || "A deleted rule"}</b><span>{label} · {when(r.at)} · {outcome(r).split(" · ").pop()}</span></span>
      </div>
      {r.result === "stopped" && r.errorCode === "MAX_DEPTH" ? <div className="ap-ban warn"><TriangleAlert size={16} aria-hidden="true" /><span>Stopped: this was the third rule in a chain. Rules can start other rules up to 3 deep, so loops end.</span></div> : null}
      <div className="rd-s"><div className="rd-k">Trigger</div>{TRIGGER_WORDS[r.trigger] ?? r.trigger}{p.rule ? <> · <Words parts={whenParts(p.rule.trigger, p.dbs, p.lists)} /></> : null}</div>
      <div className="rd-s">
        <div className="rd-k">Actions</div>
        {(p.rule?.actions ?? []).map((a, i) => (
          <div key={i} className={"rd-a" + (r.result === "failed" ? " bad" : "")}>
            {r.result === "failed" ? <CircleAlert size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
            <span><Words parts={actionParts(a, db, p.dbs, p.person)} />{a.kind === "http.post" && r.httpStatus ? <span>{r.httpStatus} after {(r.durationMs / 1000).toFixed(1)} s · tried up to 3 times (now, 1 min, 10 min)</span> : null}</span>
          </div>
        ))}
        <p className="re-sub">{outcome(r)}</p>
      </div>
      <div className="rd-s"><div className="rd-k">Runs for</div>{p.rule?.ownerName ?? p.rule?.ownerId ?? "Its owner"} · edit access checked with {p.hostName}</div>
      <div className="rd-s"><div className="rd-k">Run id</div><code>{r.id}</code></div>
      {p.onEdit ? <div className="re-f"><span className="grow" /><button className="btn" onClick={p.onEdit}>Edit rule</button></div> : null}
    </>
  );
}
