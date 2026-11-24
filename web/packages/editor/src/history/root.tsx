// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Version history (VH-01d, VH-02b), to the approved frames (docs/prototypes/version-history-
// approved): the panel (1b/1c), naming (2a/2b), the read-only preview (3a), Show changes and
// Compare with (4a-4d), restore with a 30 s Undo (5a/5b, 6a), view-only (7a), hosts without
// history (8a-8c) and the phone layout (9a-9d). A lazy chunk: nothing here is in the initial JS.
import "./history.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Editor } from "@tiptap/react";
import type { OcUser, Role } from "@opencanvas/ui";
import { ArrowLeft, ArrowLeftRight, ChevronUp, ExternalLink, GitCompareArrows, History, List, Minus, Move, Pencil, Plus, Tag } from "lucide-react";
import { ICONS, Ic } from "../icons";
import { CanvasEditor } from "../editor/CanvasEditor";
import { DocHeader } from "../components/DocHeader";
import { Avatar, Modal, ModalHead, Popover } from "../components/overlay";
import { BridgeCtx, type Bridge } from "../lib/bridge";
import { postToHost } from "../lib/host";
import { useMeta } from "../lib/meta";
import type { Peer } from "../lib/presence";
import type { Session } from "../lib/session";
import { toast } from "../lib/store";
import type { TemporaryWording } from "../lib/wording";
import { diff as fetchDiff, HistoryError, listVersions, nameVersion, restoreVersion, undoRestore, versionState, type HistoryList } from "./api";
import { changeList, type Change, type Diff } from "./changes";
import { changesPlugin, inPageOrder, markDom, setTextChanges, targetOf } from "./decorate";
import { clock, groupVersions, stamp, versionBefore, versionLabel, type Item, type Version } from "./group";

Object.assign(ICONS, {
  "arrow-left": ArrowLeft, "arrow-left-right": ArrowLeftRight, "chevron-up": ChevronUp, "external-link": ExternalLink,
  "git-compare-arrows": GitCompareArrows, history: History, list: List, minus: Minus, move: Move, pencil: Pencil, plus: Plus, tag: Tag,
});

export interface HistoryProps {
  session: Session;
  bridge: Bridge;
  liveDoc: Y.Doc;
  me: OcUser;
  peers: Peer[];
  person(id: string): OcUser;
  compact: boolean;
  role: Role;
  temporary: boolean;
  words: TemporaryWording;
  /** Bumped when the room saved or someone restored: the list refreshes. */
  tick: number;
  /** The newest saved version this editor was told about (the `saved` control). */
  known?: string | null;
  /** Bumped by the menu's "Name this version": the naming popover opens. */
  nameReq: number;
  onClose(): void;
  onPreview(on: boolean): void;
  onDownload(): void;
}

type Base = { k: "before" } | { k: "current" } | { k: "v"; v: Version };
const UNDO_MS = 30_000;

const firstName = (n: string) => n.split(/\s+/)[0] || n;
/** "Jonas", "Jonas and Lea", "Jonas, Lea and Sam", "Jonas, Lea and 3 others". */
export function namesOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

export default function HistoryRoot(p: HistoryProps) {
  const { session } = p;
  const ticket = session.ticket;
  const host = session.historyHostName || session.host.name;
  const mode = p.temporary ? "temporary" : session.history ?? "none";
  const edit = p.role === "edit" && !p.temporary;
  const canName = edit && mode === "full" && session.perms.commitMessage !== false;
  const canRestore = edit && mode === "full" && session.perms.restore !== false;
  const others = p.peers.filter((x) => !x.me && !x.agent && x.role === "edit");

  const [list, setList] = useState<{ s: "loading" } | { s: "error"; message: string; off?: boolean } | { s: "ready"; data: HistoryList }>({ s: "loading" });
  const [filter, setFilter] = useState<"all" | "named">("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [full, setFull] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Version | null>(null);
  const [changes, setChanges] = useState(false);
  const [base, setBase] = useState<Base>({ k: "before" });
  const [picking, setPicking] = useState(false);
  const [naming, setNaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const nameBtn = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const knownRef = useRef(p.known);
  knownRef.current = p.known;

  // ---------- the list ----------
  const load = useCallback(
    async (more?: string) => {
      try {
        const d = await listVersions(ticket, more, knownRef.current);
        setList((prev) => (more && prev.s === "ready" ? { s: "ready", data: { ...d, versions: [...prev.data.versions, ...d.versions] } } : { s: "ready", data: d }));
      } catch (e) {
        const he = e instanceof HistoryError ? e : null;
        setList({ s: "error", message: he?.message ?? "The versions couldn't load.", off: he?.code === "HISTORY_OFF" });
      }
    },
    [ticket],
  );
  useEffect(() => {
    if (mode !== "full") return;
    const t = window.setTimeout(() => void load(), p.tick ? 600 : 0);
    return () => window.clearTimeout(t);
  }, [mode, load, p.tick]);
  useEffect(() => headRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (p.nameReq && canName) setNaming(true);
  }, [p.nameReq, canName]);

  const versions = useMemo(() => (list.s === "ready" ? list.data.versions : []), [list]);
  const shown = useMemo(() => (filter === "named" ? versions.filter((v) => v.kind === "named") : versions), [versions, filter]);
  const days = useMemo(() => groupVersions(shown), [shown]);
  const source = list.s === "ready" ? list.data.source : session.historySource ?? null;

  // ---------- preview and changes ----------
  const preview = sel !== null;
  useEffect(() => {
    p.onPreview(preview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);
  useEffect(() => () => p.onPreview(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const before = sel ? versionBefore(versions, sel.version) : null;
  const baseV: Version | "current" | null = !sel ? null : base.k === "current" ? "current" : base.k === "v" ? base.v : before;
  const [state, setState] = useState<{ s: "loading" } | { s: "error"; message: string } | { s: "ready"; bytes: Uint8Array; current: boolean }>({ s: "loading" });
  const [dz, setDz] = useState<{ s: "off" } | { s: "loading" } | { s: "error"; message: string } | { s: "ready"; d: Diff; from: string; to: string }>({ s: "off" });
  const showCurrent = changes && baseV === "current";

  useEffect(() => {
    if (!sel) return;
    let off = false;
    setState({ s: "loading" });
    if (showCurrent) {
      setState({ s: "ready", bytes: Y.encodeStateAsUpdate(p.liveDoc), current: true });
      return;
    }
    versionState(ticket, sel.version).then(
      (bytes) => !off && setState({ s: "ready", bytes, current: false }),
      (e: unknown) => !off && setState({ s: "error", message: e instanceof Error ? e.message : "This version couldn't open." }),
    );
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.version, showCurrent, ticket]);

  useEffect(() => {
    if (!sel || !changes || !baseV) return setDz({ s: "off" });
    let off = false;
    setDz({ s: "loading" });
    const [from, to] = baseV === "current" ? [sel.version, "current"] : [baseV.version, sel.version];
    fetchDiff(ticket, from, to).then(
      (d) => !off && setDz({ s: "ready", d, from: baseV === "current" ? stamp(Date.parse(sel.at)) : stamp(Date.parse(baseV.at)), to: baseV === "current" ? "now" : stamp(Date.parse(sel.at)) }),
      (e: unknown) => !off && setDz({ s: "error", message: e instanceof Error ? e.message : "The changes couldn't load." }),
    );
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.version, changes, baseV === "current" ? "current" : baseV?.version, ticket]);

  const back = useCallback(() => {
    setSel(null);
    setChanges(false);
    setBase({ k: "before" });
    setPicking(false);
  }, []);
  useEffect(() => {
    if (!preview) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".pop,.modal,.sheet") || document.querySelector(".modal")) return;
      back();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [preview, back]);

  const pick = (v: Version) => {
    if (picking && sel) {
      if (v.version !== sel.version) setBase({ k: "v", v });
      setPicking(false);
      return;
    }
    setSel(v);
    setBase({ k: "before" });
  };

  // ---------- naming and restore ----------
  const doName = async (name: string) => {
    try {
      const r = await nameVersion(ticket, name);
      setNaming(false);
      setFilter("all");
      toast(`Saved as “${r.name ?? name}”`, { icon: "check" });
      setFresh(r.version ?? `name:${name}`);
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "The name couldn't be saved. Try again.", { icon: "triangle-alert" });
    }
  };
  const doRestore = async () => {
    if (!sel) return;
    const label = versionLabel(sel);
    setConfirm(false);
    try {
      const r = await restoreVersion(ticket, sel.version, label);
      back();
      setFresh(r.version ?? null);
      void load();
      toast(sel.kind === "named" ? `Restored ${label}` : `Restored the version from ${label}`, {
        icon: "rotate-ccw",
        ms: UNDO_MS,
        action: {
          label: "Undo",
          run: () =>
            void undoRestore(ticket, r.restoreId).then(
              () => {
                toast("Restore undone", { icon: "rotate-ccw" });
                void load();
              },
              (e: unknown) => toast(e instanceof Error ? e.message : "This restore can't be undone any more.", { icon: "triangle-alert" }),
            ),
        },
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "The version couldn't be restored. Try again.", { icon: "triangle-alert" });
    }
  };

  // ---------- rendering ----------
  const who = (ids: string[] | undefined, short = false) => (ids ?? []).map((id) => (short ? firstName(p.person(id).name) : p.person(id).name));
  const avatars = (ids: string[] | undefined) =>
    ids?.length ? (
      <span className="vh-avs" aria-hidden="true">
        {ids.slice(0, 3).map((id) => {
          const u = p.person(id);
          return <Avatar key={id} name={u.name} color={u.color} avatar={u.avatar} cls="sm" />;
        })}
      </span>
    ) : null;
  const isFresh = (v: Version) => !!fresh && (v.version === fresh || (fresh.startsWith("name:") && v.name === fresh.slice(5) && v === versions.find((x) => x.name === v.name)));
  const chipFor = (v: Version) =>
    changes && sel ? (
      v.version === sel.version ? (
        <span className="vh-chip purple">Compare to</span>
      ) : baseV !== "current" && baseV?.version === v.version ? (
        <span className="vh-chip blue">Compare from</span>
      ) : null
    ) : isFresh(v) ? (
      <span className="vh-chip green">New</span>
    ) : null;

  const row = (v: Version, label: string, icon: string, cls: string, sub: string) => (
    <button
      key={v.version}
      className={"vh-v " + cls + (changes && baseV !== "current" && baseV?.version === v.version ? " base" : "")}
      aria-current={sel?.version === v.version ? "true" : undefined}
      onClick={() => pick(v)}
    >
      <span className="vh-vi" aria-hidden="true">
        <Ic name={icon} size={15} />
      </span>
      <span className="vh-vm">
        <span className="vh-vt">
          <span className="tx">{label}</span>
        </span>
        <span className="vh-vs">{sub}</span>
      </span>
      <span className="vh-vr">
        {chipFor(v)}
        {avatars(v.authors)}
      </span>
    </button>
  );

  const renderItem = (it: Item) => {
    if (it.k === "one") {
      const v = it.v;
      const restore = v.kind === "restore";
      const by = who(v.authors).join(", ");
      const t = Date.parse(v.at);
      const sub = it.label === "Before restore" ? `${clock(t)} · saved automatically` : `${clock(t)}${by ? " · " + by : ""}`;
      return row(v, it.label, restore ? "rotate-ccw" : it.label === "Before restore" ? "clock" : "tag", restore ? "restore" : it.label === "Before restore" ? "auto" : "named", sub);
    }
    const last = it.saves[0];
    const n = it.saves.length;
    const range = n > 1 ? `${clock(it.from)} – ${clock(it.to)}` : clock(it.to);
    const isOpen = open.has(it.id);
    const subs = full.has(it.id) ? it.saves : it.saves.slice(0, 4);
    return (
      <div key={it.id} className="vh-sess">
        {row(last, range, "clock", "auto", `Edited by ${who(it.authors).join(", ") || "someone"}`)}
        <button
          className="vh-fold"
          aria-expanded={isOpen}
          onClick={() =>
            setOpen((s) => {
              const x = new Set(s);
              if (x.has(it.id)) x.delete(it.id);
              else x.add(it.id);
              return x;
            })
          }
        >
          <Ic name="chevron-right" size={12} />
          {n === 1 ? "1 save" : `${n} saves`}
        </button>
        {isOpen ? (
          <ul className="vh-subs" aria-label={`Saves from ${range}`}>
            {subs.map((v) => (
              <li key={v.version}>
                <button className="vh-sr" aria-current={sel?.version === v.version ? "true" : undefined} onClick={() => pick(v)}>
                  {clock(Date.parse(v.at))}
                  <span className="who">{who(v.authors, true).join(", ")}</span>
                </button>
              </li>
            ))}
            {subs.length < n ? (
              <li>
                <button className="vh-sr more" onClick={() => setFull((s) => new Set(s).add(it.id))}>
                  Show {n - subs.length} more saves
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    );
  };

  const empty = (icon: string, tone: string, title: string, sub: string, action?: React.ReactNode) => (
    <div className="vh-empty">
      <span className={`vh-ei tone-${tone}`}>
        <Ic name={icon} size={20} />
      </span>
      <h3>{title}</h3>
      <p>{sub}</p>
      {action}
    </div>
  );

  let body: React.ReactNode;
  if (mode === "temporary")
    body = empty(
      "clock",
      "gray",
      p.words.historyTitle,
      p.words.historySub,
      session.perms.download !== false || session.perms.export !== false ? (
        <button className="btn" onClick={p.onDownload}>
          <Ic name="download" size={15} />
          Download a copy
        </button>
      ) : undefined,
    );
  else if (mode === "link")
    body = empty(
      "history",
      "blue",
      `${host} keeps the versions`,
      `Every save of this canvas is a version in ${host}. Open its Versions tab to see or restore them.`,
      <button
        className="btn"
        onClick={() => {
          if (session.historyPostMessage || !session.historyUrl) postToHost("UI_FileVersions", {});
          else window.open(session.historyUrl, "_blank", "noopener,noreferrer");
        }}
      >
        <Ic name="external-link" size={15} />
        Open Versions in {host}
      </button>,
    );
  else if (mode !== "full" || (list.s === "error" && list.off))
    body = empty("history", "gray", "Version history isn’t available here", `${host} keeps this canvas. If it keeps earlier versions, you’ll find them there.`);
  else if (list.s === "loading") body = <div className="vh-note" aria-busy="true">Loading versions…</div>;
  else if (list.s === "error")
    body = (
      <div className="vh-note" role="alert">
        {list.message}
        <br />
        <button className="btn sm" onClick={() => (setList({ s: "loading" }), void load())}>
          Try again
        </button>
      </div>
    );
  else
    body = (
      <>
        <div className="vh-pf">
          <div className="vh-seg" role="group" aria-label="Show">
            <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All
            </button>
            <button aria-pressed={filter === "named"} onClick={() => setFilter("named")}>
              Named
            </button>
          </div>
          {canName && !p.compact ? (
            <button className="btn sm" ref={nameBtn} onClick={() => setNaming(true)} aria-haspopup="dialog">
              <Ic name="tag" size={14} />
              Name this version
            </button>
          ) : null}
        </div>
        <div className="vh-pl">
          {picking ? (
            <div className="vh-note">
              Pick a version to compare with.{" "}
              <button className="btn sm ghost" onClick={() => setPicking(false)}>
                Cancel
              </button>
            </div>
          ) : null}
          {filter === "all" ? (
            <>
              <h3 className="vh-day">Today</h3>
              <button className="vh-v live" aria-current={!sel ? "true" : undefined} onClick={back}>
                <span className="vh-vi" aria-hidden="true">
                  <Ic name="circle-check" size={15} />
                </span>
                <span className="vh-vm">
                  <span className="vh-vt">
                    <span className="tx">Current version</span>
                  </span>
                  <span className="vh-vs">{others.length ? `${namesOf(others.map((x) => firstName(x.name)))} ${others.length === 1 ? "is" : "are"} editing` : "Live"}</span>
                </span>
                <span className="vh-vr">{avatars(others.map((x) => x.id))}</span>
              </button>
            </>
          ) : null}
          {days.map((d, i) => (
            <section key={d.key} aria-label={d.label}>
              {i === 0 && d.label === "Today" && filter === "all" ? null : <h3 className="vh-day">{d.label}</h3>}
              {d.items.map(renderItem)}
            </section>
          ))}
          {!shown.length ? <p className="vh-note">{filter === "named" ? "No named versions yet." : "No earlier versions yet. They appear here as the canvas saves."}</p> : null}
          {list.data.next && filter === "all" ? (
            <button className="btn sm ghost" style={{ margin: ".5rem" }} onClick={() => void load(list.data.next)}>
              Show older versions
            </button>
          ) : null}
        </div>
        <p className="vh-pfoot">
          <Ic name="info" size={14} />
          <span>
            {source === "file" ? (
              <>
                <b>Kept in this file.</b> {edit ? "The oldest automatic versions make room for new ones." : "You can view this canvas. People who can edit can name and restore versions."}
              </>
            ) : (
              <>
                <b>Kept by {host}.</b> {edit ? `Older automatic saves may be thinned by ${host}.` : "You can view this canvas. People who can edit can name and restore versions."}
              </>
            )}
          </span>
        </p>
      </>
    );

  const panel = (
    <aside className="side vh-panel" aria-label="Version history">
      <div className="vh-ph">
        {p.compact ? (
          <button className="ib" aria-label="Back to the canvas" title="Back to the canvas" onClick={p.onClose}>
            <Ic name="arrow-left" size={18} />
          </button>
        ) : null}
        <h2 ref={headRef} tabIndex={-1}>
          {p.compact ? null : <Ic name="history" size={16} />}
          Version history
        </h2>
        {p.compact && canName && list.s === "ready" ? (
          <button className="btn sm" ref={nameBtn} onClick={() => setNaming(true)} aria-haspopup="dialog">
            <Ic name="tag" size={14} />
            Name
          </button>
        ) : null}
        {!p.compact ? (
          <button className="ib" aria-label="Close version history" title="Close" onClick={p.onClose}>
            <Ic name="x" size={16} />
          </button>
        ) : null}
      </div>
      {body}
      {naming ? <NamePopover anchor={nameBtn.current ?? headRef.current!} onClose={() => setNaming(false)} onSave={doName} /> : null}
    </aside>
  );

  return (
    <>
      {sel ? (
        <Preview
          {...p}
          sel={sel}
          state={state}
          dz={dz}
          changes={changes}
          setChanges={setChanges}
          base={base}
          baseV={baseV}
          setBase={setBase}
          versions={versions}
          canRestore={canRestore}
          onBack={back}
          onRestore={() => setConfirm(true)}
          onPickFromList={() => setPicking(true)}
        />
      ) : null}
      {!(p.compact && sel) ? panel : null}
      {confirm && sel ? (
        <Modal onClose={() => setConfirm(false)} label="Restore this version">
          {others.length ? (
            <ModalHead title={`${namesOf(others.map((x) => firstName(x.name)))} ${others.length === 1 ? "is" : "are"} editing`} icon="users-round" tone="amber" />
          ) : (
            <ModalHead title="Restore this version?" icon="rotate-ccw" tone="blue" />
          )}
          <div className="mbd vh-confirm">
            {others.length ? (
              <>
                <p>Restoring changes the canvas for them too. They’ll see a note that you restored it.</p>
                <p>What they’ve typed so far is saved in “Before restore”. Anything they type afterwards is kept.</p>
                {others.map((x) => (
                  <div className="vh-who" key={x.id}>
                    <Avatar name={x.name} color={x.color} avatar={x.avatar} cls="" />
                    {x.name}
                    <span className="dim">{x.typing ? "typing" : "editing"}</span>
                  </div>
                ))}
              </>
            ) : (
              <p>
                The canvas goes back to how it was on {stamp(Date.parse(sel.at))}
                {sel.kind === "named" && sel.name ? ` (“${sel.name}”)` : ""}. The current canvas is saved as a version first, so you can come back to it. Comments are kept.
              </p>
            )}
          </div>
          <div className="mft">
            <button className={"btn ghost" + (p.compact ? " blk" : "")} onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className={"btn vh-pri" + (p.compact ? " blk" : "")} data-autofocus onClick={() => void doRestore()}>
              <Ic name="rotate-ccw" size={15} />
              {others.length ? "Restore for everyone" : "Restore"}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function NamePopover({ anchor, onClose, onSave }: { anchor: HTMLElement; onClose(): void; onSave(name: string): Promise<void> }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = v.trim().length > 0 && v.trim().length <= 120;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    await onSave(v.trim());
    setBusy(false);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} title="Name this version" kind="dialog" alignRight>
      <form
        className="vh-name"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3 id="vh-name-t">Name this version</h3>
        <input aria-labelledby="vh-name-t" data-autofocus maxLength={120} value={v} placeholder="Ready for sprint review" onChange={(e) => setV(e.target.value)} />
        <p>Saves the canvas as it is now under this name. Everyone with access sees it in Version history.</p>
        <div className="act">
          <button type="button" className="btn ghost sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn vh-pri sm" disabled={!ok || busy}>
            Save name
          </button>
        </div>
      </form>
    </Popover>
  );
}

// ---------- the preview ----------

interface PreviewProps extends HistoryProps {
  sel: Version;
  state: { s: "loading" } | { s: "error"; message: string } | { s: "ready"; bytes: Uint8Array; current: boolean };
  dz: { s: "off" } | { s: "loading" } | { s: "error"; message: string } | { s: "ready"; d: Diff; from: string; to: string };
  changes: boolean;
  setChanges(v: boolean): void;
  base: Base;
  baseV: Version | "current" | null;
  setBase(b: Base): void;
  versions: Version[];
  canRestore: boolean;
  onBack(): void;
  onRestore(): void;
  onPickFromList(): void;
}

function Preview(p: PreviewProps) {
  const { sel } = p;
  const by = (sel.authors ?? []).map((id) => p.person(id).name).join(", ");
  const label = sel.kind === "named" && sel.name ? sel.name : sel.kind === "restore" && sel.name ? sel.name : `Version of ${stamp(Date.parse(sel.at))}`;
  const [cmp, setCmp] = useState<HTMLElement | null>(null);
  const [list, setList] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [idx, setIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const diffD = p.dz.s === "ready" && p.changes ? p.dz.d : null;

  const textOf = useCallback(
    (ref: { blockId?: string; path: string }) => {
      const el = rootRef.current;
      if (!editor || !el) return "";
      let t = "";
      editor.state.doc.descendants((n) => {
        if (t) return false;
        if (ref.blockId && n.attrs.blockId === ref.blockId) {
          t = n.textContent;
          return false;
        }
        return true;
      });
      return t;
    },
    [editor],
  );
  const changeItems: Change[] = useMemo(
    () =>
      diffD
        ? changeList(diffD, {
            blockText: textOf,
            rowTitle: (db, r) => rootRef.current?.querySelector(`.ocdb[data-db="${CSS.escape(db)}"] tr[data-row="${CSS.escape(r)}"] td[data-c="0"]`)?.textContent?.trim() ?? "",
            shapeText: (b, s) => rootRef.current?.querySelector(`[data-board="${CSS.escape(b)}"] g[data-s="${CSS.escape(s)}"]`)?.textContent?.trim() ?? "",
          })
        : [],
    [diffD, textOf],
  );

  // Text decorations follow the preview's content as y-prosemirror fills it in.
  useEffect(() => {
    if (!editor) return;
    const run = () => setTextChanges(editor, diffD, changeItems);
    run();
    editor.on("update", run);
    return () => {
      editor.off("update", run);
    };
  }, [editor, diffD, changeItems]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !diffD) return;
    return markDom(el, diffD);
  }, [diffD, editor]);
  useEffect(() => setIdx(0), [diffD]);

  const order = () => (rootRef.current ? inPageOrder(rootRef.current, changeItems) : changeItems.map((c, i) => ({ c, i })));
  const go = (k: number) => {
    const o = order();
    if (!o.length || !rootRef.current) return;
    const n = ((k % o.length) + o.length) % o.length;
    setIdx(n);
    rootRef.current.querySelectorAll(".vh-hl").forEach((e) => e.classList.remove("vh-hl"));
    const el = targetOf(rootRef.current, o[n].c, o[n].i);
    if (el) {
      el.classList.add("vh-hl");
      (el instanceof SVGElement ? el.closest(".stubhost") ?? el : el).scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  const baseLabel = p.baseV === "current" ? "Current version" : p.baseV ? (p.baseV.kind === "named" && p.baseV.name ? p.baseV.name : stamp(Date.parse(p.baseV.at))) : "";
  const named = p.versions.filter((v) => v.kind === "named" && v.version !== sel.version).slice(0, 5);
  const sw = (
    <button className="vh-tg" role="switch" aria-checked={p.changes} disabled={!p.baseV && !p.changes && !versionBefore(p.versions, sel.version)} onClick={() => p.setChanges(!p.changes)} title={versionBefore(p.versions, sel.version) ? undefined : "This is the oldest version"}>
      <i aria-hidden="true" />
      {p.compact ? "Changes" : "Show changes"}
    </button>
  );
  const s = p.dz.s === "ready" ? p.dz.d.summary : null;
  const total = changeItems.length;

  return (
    <div className="vh-main" aria-label="Version preview" role="region">
      <div className="vh-pbar">
        {p.compact ? (
          <button className="ib" aria-label="Back to versions" title="Back to versions" onClick={p.onBack}>
            <Ic name="arrow-left" size={18} />
          </button>
        ) : (
          <>
            <button className="btn ghost sm" onClick={p.onBack} title="Back to the live canvas (Esc)">
              <Ic name="arrow-left" size={15} />
              Back to current
            </button>
            <span className="vh-sep" aria-hidden="true" />
          </>
        )}
        <div className="vh-ptitle">
          {p.compact ? null : <Ic name={sel.kind === "restore" ? "rotate-ccw" : sel.kind === "named" ? "tag" : "clock"} size={15} />}
          <b>{label}</b>
          {p.compact ? null : <span className="dim">{[stamp(Date.parse(sel.at)).replace(/^today/, "Today"), by].filter(Boolean).join(" · ")}</span>}
        </div>
        <span className="vh-ro">
          <Ic name="eye" size={12} />
          Read only
        </span>
        {!p.compact ? sw : null}
        {!p.compact && p.changes ? (
          <button className="vh-sel" aria-haspopup="menu" onClick={(e) => setCmp(e.currentTarget)}>
            <Ic name="git-compare-arrows" size={14} />
            Compare with <b>{baseLabel || "…"}</b>
            <Ic name="chevron-down" size={14} />
          </button>
        ) : null}
        {!p.compact && p.canRestore ? (
          <button className="btn vh-pri" onClick={p.onRestore}>
            <Ic name="rotate-ccw" size={15} />
            Restore this version
          </button>
        ) : null}
      </div>
      {p.compact ? (
        <div className="vh-psw">
          <span className="dim">{p.changes && baseLabel ? `Changes since ${baseLabel}` : "As it was"}</span>
          {sw}
        </div>
      ) : null}
      <div className="vh-pscroll">
        {p.changes && !p.compact && p.dz.s === "ready" && s ? (
          <div className="vh-sum" role="status">
            <Ic name="git-compare-arrows" size={15} />
            <b>
              {p.dz.from} → {p.dz.to}
            </b>
            <span className="vh-chip green">+ {s.added} added</span>
            <span className="vh-chip red">− {s.removed} removed</span>
            <span className="vh-chip amber">{s.changed} changed</span>
            <span className="vh-chip purple">{s.moved} moved</span>
            <span className="grow" />
            {total ? (
              <span className="vh-nav">
                <button className="ib sm" aria-label="Previous change" onClick={() => go(idx - 1)}>
                  <Ic name="chevron-up" size={15} />
                </button>
                <span className="count">
                  {idx + 1} of {total}
                </span>
                <button className="ib sm" aria-label="Next change" onClick={() => go(idx + 1)}>
                  <Ic name="chevron-down" size={15} />
                </button>
              </span>
            ) : (
              <span>No changes</span>
            )}
          </div>
        ) : null}
        {p.changes && p.dz.s === "loading" ? <div className="vh-msg" style={{ background: "var(--panel)", color: "var(--fg-2)" }}>Finding the changes…</div> : null}
        {p.changes && p.dz.s === "error" ? <div className="vh-msg" role="alert">{p.dz.message}</div> : null}
        {p.dz.s === "ready" && p.changes && p.dz.d.truncated ? <div className="vh-msg">Only the first 2,000 changes are shown.</div> : null}
        <div ref={rootRef} className={"doc vh-doc" + (p.compact ? "" : "")}>
          {p.state.s === "loading" ? <div className="vh-note" aria-busy="true">Opening this version…</div> : null}
          {p.state.s === "error" ? (
            <div className="vh-msg" role="alert">
              {p.state.message}
            </div>
          ) : null}
          {p.state.s === "ready" ? <PreviewDoc key={sel.version + (p.state.current ? ":cur" : "")} bytes={p.state.bytes} bridge={p.bridge} me={p.me} compact={p.compact} at={Date.parse(sel.at)} by={sel.authors?.[0] ? p.person(sel.authors[0]).name : null} onEditor={setEditor} /> : null}
        </div>
      </div>
      {p.compact ? (
        <div className="vh-pfoot2">
          {p.changes && total ? (
            <span className="vh-nav">
              <button className="ib" aria-label="Previous change" onClick={() => go(idx - 1)}>
                <Ic name="chevron-up" size={18} />
              </button>
              <button className="count" aria-haspopup="dialog" onClick={() => setList(true)}>
                {idx + 1} of {total}
              </button>
              <button className="ib" aria-label="Next change" onClick={() => go(idx + 1)}>
                <Ic name="chevron-down" size={18} />
              </button>
            </span>
          ) : (
            <span />
          )}
          {p.canRestore ? (
            <button className="btn vh-pri" onClick={p.onRestore}>
              <Ic name="rotate-ccw" size={16} />
              Restore
            </button>
          ) : null}
        </div>
      ) : null}
      {cmp ? (
        <Popover anchor={cmp} onClose={() => setCmp(null)} title="Compare with" className="vh-cmp" alignRight minWidth={280}>
          <div className="mh">Compare with</div>
          <button className="mi" onClick={() => (setCmp(null), p.setBase({ k: "before" }))}>
            <Ic name="arrow-left-right" />
            The version before
          </button>
          <button className="mi" onClick={() => (setCmp(null), p.setBase({ k: "current" }))}>
            <Ic name="circle-check" />
            Current version
          </button>
          {named.length ? <div className="msep" /> : null}
          {named.map((v) => (
            <button key={v.version} className="mi" onClick={() => (setCmp(null), p.setBase({ k: "v", v }))}>
              <Ic name="tag" />
              {v.name}
              <span className="when">{stamp(Date.parse(v.at)).replace(/^today, /, "Today ").replace(/, \d\d:\d\d$/, "")}</span>
            </button>
          ))}
          <button className="mi" onClick={() => (setCmp(null), p.onPickFromList())}>
            <Ic name="list" />
            Pick from the list…
          </button>
        </Popover>
      ) : null}
      {list ? (
        <Modal onClose={() => setList(false)} label={`${total} changes`}>
          <ModalHead title={total === 1 ? "1 change" : `${total} changes`} onClose={() => setList(false)} />
          <div className="mbd">
            {order().map(({ c, i }, k) => (
              <button
                key={i}
                className="vh-ch"
                onClick={() => {
                  setList(false);
                  window.requestAnimationFrame(() => go(k));
                }}
              >
                <span className={"vh-ci " + c.kind} aria-hidden="true">
                  <Ic name={c.kind === "add" ? "plus" : c.kind === "rem" ? "minus" : c.kind === "move" ? "move" : "pencil"} size={14} />
                </span>
                <span>
                  <b>{c.title}</b>
                  <span className="d">{c.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** One version, read-only, in its own throwaway Y.Doc (never the live room's). */
function PreviewDoc({ bytes, bridge, me, compact, at, by, onEditor }: { bytes: Uint8Array; bridge: Bridge; me: OcUser; compact: boolean; at: number; by: string | null; onEditor(e: Editor | null): void }) {
  const [{ doc, awareness }] = useState(() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, bytes);
    return { doc: d, awareness: new Awareness(d) };
  });
  useEffect(
    () => () => {
      awareness.destroy();
      doc.destroy();
    },
    [doc, awareness],
  );
  const meta = useMeta(doc);
  const ctx: Bridge = useMemo(
    () => ({ ...bridge, doc, awareness, env: { ...bridge.env, role: "view", compact, undoManager: undefined, importToBoard: undefined } }),
    [bridge, doc, awareness, compact],
  );
  const ready = useCallback(
    (e: Editor | null) => {
      if (e) e.registerPlugin(changesPlugin());
      onEditor(e);
    },
    [onEditor],
  );
  return (
    <BridgeCtx.Provider value={ctx}>
      <DocHeader doc={doc} meta={meta} editable={false} hostName="" lastEdit={at} lastEditBy={by} peopleHere={0} onEnter={() => undefined} />
      <CanvasEditor doc={doc} awareness={awareness} role="view" me={me} users={[]} searchUsers={async () => []} onReady={ready} onComment={() => undefined} />
    </BridgeCtx.Provider>
  );
}
