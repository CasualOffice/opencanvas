// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/react";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type { BlockEnv, OcUser, Role } from "@opencanvas/ui";
import { Ic, loadExtraIcons } from "./icons";
import { CanvasEditor } from "./editor/CanvasEditor";
import { focusEndOnClickBelow } from "./editor/clickBelow";
import { flashBlock } from "./editor/blockId";
import { followScroll, reportView } from "./editor/follow";
import { loadDatabase } from "./editor/blockdata";
import { blockActions } from "./editor/chart/actions";
import type { TB } from "./editor/content";
import type { EmptyAction } from "./editor/CanvasEditor";
import { featureOn, insertable } from "./editor/profile";
import { resolveAsset, setAssetTicket } from "./lib/assets";
import { setUnfurl } from "./lib/unfurl";
import { BridgeCtx, setBridge, type Bridge, type Uploaded } from "./lib/bridge";
import { deleteThread, useThreads } from "./lib/comments";
import type { Demo } from "./lib/demo";
import { demoIcons, serverIcons } from "./lib/icons";
import type { ExportFormat } from "./lib/exports";
import { onHost, postToHost } from "./lib/host";
import { linkTarget } from "./editor/blockLink";
import { installLiveHost } from "./live/state";
import { META_ORIGIN, setMeta, useLastEdit, useMeta } from "./lib/meta";
import { isMac } from "./lib/keys";
import { aiAvailability, aiStore, openAssistant } from "./lib/assistant";
import { usePeers, type Peer } from "./lib/presence";
import { People, setPeople } from "./lib/people";
import { connectCollab, fetchSession, readLaunch, SessionError, type Collab, type Session } from "./lib/session";
import { DIAGRAM_FORMATS, importFormats, importOpenStore, importStore, openImport } from "./lib/importflag";
import { exportBoardText } from "./lib/boardexport";
import { renewSession, savedAtLabel, schedule, WARN_S, type AccessState } from "./lib/access";
import { toast, useStore } from "./lib/store";
import { restoredText } from "./lib/restored";
import { DocHeader } from "./components/DocHeader";
import type { ImportResult } from "./components/Dialogs";
import { ShellCtx, Toasts } from "./components/overlay";
import { TopBar, type SaveState } from "./components/TopBar";
import { leaveGuard, offlineView, patchView, reconnectToken } from "./offline/status";
import { showsGallery, temporaryWording, wordingOf } from "./lib/wording";
import { appRootOf, resolveApp, setAppRoot } from "./lib/appmode";
import { profileStore } from "./editor/profile";
import type { Template } from "./templates";
import type { TeamItem, TeamState } from "./lib/teamtemplates";
import { teamEnabled } from "./lib/teamflag";
/** The team templates' calls, loaded with the gallery (not in the first load). */
const teamApi = () => import("./lib/teamtemplates");

// Everything below is off the first paint (docs/02 §7 bundle budget): it loads
// when first shown.
const Gallery = lazy(() => import("./components/Gallery").then((m) => ({ default: m.Gallery })));
const CommentsPanel = lazy(() => import("./components/CommentsPanel").then((m) => ({ default: m.CommentsPanel })));
const ImportDialog = lazy(() => import("./components/Dialogs").then((m) => ({ default: m.ImportDialog })));
const UrlPrompt = lazy(() => import("./components/Dialogs").then((m) => ({ default: m.UrlPrompt })));
const ImportInto = lazy(() => import("./components/ImportInto").then((m) => ({ default: m.ImportInto })));
const CsvImportDialog = lazy(() => loadDatabase().then((m) => ({ default: m.CsvImportDialog })));
const AssistantRoot = lazy(() => import("./assistant/root"));
const Shortcuts = lazy(() => import("./components/Shortcuts").then((m) => ({ default: m.Shortcuts })));
// VH-01d: the version history panel, preview and changes (its own chunk, with its CSS).
const HistoryRoot = lazy(() => import("./history/root"));
// OFF-06: offline dialogs, banners and the merge summary (only for hosts with offline copies).
const OfflineRoot = lazy(() => import("./offline/ui").then((m) => ({ default: m.OfflineRoot })));
const OfflineBanners = lazy(() => import("./offline/ui").then((m) => ({ default: m.OfflineBanners })));
const LockedCanvas = lazy(() => import("./offline/ui").then((m) => ({ default: m.LockedCanvas })));
const offlineUi = () => import("./offline/ui");
// SRCH-01/04: the find bar and "Search all canvases" load when first opened (initial JS budget).
const FindBar = lazy(() => import("./find/FindBar").then((m) => ({ default: m.FindBar })));
// AUTO-06: the automations panel loads when first opened.
const AutomationPanel = lazy(() => import("./automation/AutomationPanel").then((m) => ({ default: m.AutomationPanel })));
const SearchAll = lazy(() => import("./search/SearchAll").then((m) => ({ default: m.SearchAll })));
// LINK-04 (ADR-081): `[[`, Linked from, previews and chips; a chunk of its own.
const LinksRoot = lazy(() => import("./links/root"));
// GRAPH-02/03 (ADR-082): the local and full knowledge graph; a chunk of its own (GRAPH-A4).
const GraphRoot = lazy(() => import("./graph/root"));
// LIVE-06: `<open-canvas view="block">`, the compact embed of one live file.
const BlockEmbed = lazy(() => import("./live/embed"));
// WEB-08 budget: the workspace's modals and the database "Automate" menu (fetched after first
// paint, so they show at once when needed).
const workspaceModals = () => import("./components/WorkspaceModals");
const ReplaceConfirm = lazy(() => workspaceModals().then((m) => ({ default: m.ReplaceConfirm })));
const ConflictModal = lazy(() => workspaceModals().then((m) => ({ default: m.ConflictModal })));
const ClosedModal = lazy(() => workspaceModals().then((m) => ({ default: m.ClosedModal })));
const AutomateMenu = lazy(() => workspaceModals().then((m) => ({ default: m.AutomateMenu })));
const PersonCards = lazy(() => import("./components/PersonCard").then((m) => ({ default: m.PersonCards })));
const blockView = () => new URLSearchParams(window.location.hash.replace(/^#/, "")).get("view") === "block";

/** A downgrade whose unsynced edits the server refused: the client starts over and the next
 *  Workspace shows the banner once (docs/23 PERM-03). Per room, in sessionStorage, so it
 *  survives the restart and a page reload. */
/** Prototype 5: the temporary-canvas note, once hidden, stays hidden for this room in this tab. */
const tempNoteKey = (room: string) => `oc:tempnote:${room}`;
function tempNoteHidden(room: string): boolean {
  try {
    return sessionStorage.getItem(tempNoteKey(room)) === "1";
  } catch {
    return false;
  }
}

const downgradeKey = (room: string) => `oc:downgraded:${room}`;
function markDowngraded(room: string) {
  try {
    sessionStorage.setItem(downgradeKey(room), "1");
  } catch {
    /* storage blocked: the banner is lost, the edits are still dropped */
  }
}
function peekDowngraded(room: string): boolean {
  try {
    return sessionStorage.getItem(downgradeKey(room)) === "1";
  } catch {
    return false;
  }
}
function clearDowngraded(room: string) {
  try {
    sessionStorage.removeItem(downgradeKey(room));
  } catch {
    /* nothing to clear */
  }
}

const EXPORTS = new Set(["md", "html", "ocanvas", "json", "docx", "pdf"]);

function Splash() {
  return (
    <div className="splash" aria-busy="true" aria-label="Loading canvas">
      <div className="skel">
        <i style={{ width: 52, height: 52, borderRadius: 14 }} />
        <i style={{ width: "55%", height: 30, borderRadius: 8 }} />
        <i style={{ width: "30%" }} />
        <i style={{ width: "92%", marginTop: 18 }} />
        <i style={{ width: "84%" }} />
        <i style={{ width: "66%" }} />
      </div>
    </div>
  );
}

/** OFF-03: the kept canvas a ticket opened (ids only), so a reload without a network finds it. */
function keptFor(ticket: string): { h: string; u: string; f: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem("oc:offline-launch") ?? "null");
    return v && v.t === ticket ? v : null;
  } catch {
    return null;
  }
}

type Boot =
  | { phase: "loading" }
  | { phase: "error"; title: string; message: string; retry?: boolean }
  | { phase: "ready"; session: Session; collab: Collab; demo: Demo | null; gen: number };

/** The compact breakpoint in CSS px: 45em of the root font size (ADR-050). */
function compactBelow(): number {
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return 45 * (Number.isFinite(fs) && fs > 0 ? fs : 16);
}

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  // Bumped to drop the local Y.Doc and start over from the server (`reload` conflict policy).
  const [gen, setGen] = useState(0);

  useEffect(() => {
    if (gen === 0) postToHost("App_LoadingStatus", { Status: "Frame_Ready" });
    else setBoot({ phase: "loading" });
    const { ticket, demo } = readLaunch();
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const theme = params.get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    let collab: Collab | null = null;
    let d: Demo | null = null;
    let cancelled = false;
    (async () => {
      if (demo) {
        const role = (["view", "comment", "edit"].includes(params.get("role") ?? "") ? params.get("role") : "edit") as Role;
        const m = await import("./lib/demo");
        if (cancelled) return;
        d = m.createDemo(role);
        setBoot({ phase: "ready", session: m.demoSession(role), collab: d.collab, demo: d, gen });
        return;
      }
      // OFF-03: opened from the device without a launch (the service worker, or `<open-canvas offline>`).
      const kept = ticket ? keptFor(ticket) : null;
      const openKept = async (h: string, u: string, f: string) => {
        const m = await import("./offline/controller");
        const o = await m.openOffline(h, u, f).catch(() => null);
        if (cancelled) return;
        if (!o) {
          setBoot({ phase: "error", title: "This canvas isn't on this device", message: "Connect to the internet and open it again from your app." });
          return;
        }
        o.session.openedOffline = true;
        collab = connectCollab(o.session, { doc: o.doc, connect: false });
        collab.pending.restore(o.pending);
        // PSYNC-03: the parts kept with the copy; the next connection syncs each with the room.
        if (o.parts) collab.parts?.restore(o.parts.list, o.parts.states);
        patchView({ locked: o.locked, openedOffline: true, kept: true, net: "offline", validUntil: o.claims ? o.claims.exp * 1000 : null });
        setBoot({ phase: "ready", session: o.session, collab, demo: null, gen });
      };
      if (!ticket && params.get("offline") === "1") return openKept(params.get("h") ?? "", params.get("u") ?? "", params.get("f") ?? "");
      if (!ticket) {
        setBoot({ phase: "error", title: "Open this canvas from your app", message: "This page needs a launch link from the app that stores the canvas." });
        return;
      }
      try {
        const s = await fetchSession(ticket);
        if (cancelled) return;
        setAssetTicket(s.ticket);
        setUnfurl(s.unfurl === true);
        collab = connectCollab(s);
        await collab.synced;
        if (cancelled) return;
        setBoot({ phase: "ready", session: s, collab, demo: null, gen });
      } catch (e) {
        // A kept canvas reloaded without a network: open the copy on this device.
        if (!(e instanceof SessionError) && kept && !cancelled) return openKept(kept.h, kept.u, kept.f);
        const msg = e instanceof SessionError ? e.message : "We couldn't reach the canvas server. Check your connection and try again.";
        postToHost("Error", { code: e instanceof SessionError ? e.code : "NETWORK", message: msg });
        // An expired link can't be retried from here; a network or server error can.
        setBoot({ phase: "error", title: "Can't open this canvas", message: msg, retry: !(e instanceof SessionError && e.code === "TICKET_INVALID") });
      }
    })();
    return () => {
      cancelled = true;
      collab?.destroy();
      d?.destroy();
    };
  }, [gen]);

  // A reboot bumps `gen` one render before the effect resets `boot`: never mount the next
  // Workspace on the previous (destroyed) session.
  if (boot.phase === "loading" || (boot.phase === "ready" && boot.gen !== gen)) return <Splash />;
  if (boot.phase === "error")
    return (
      <div className="splash" role="alert">
        <div className="card">
          <span className="cic tone-gray" style={{ width: 44, height: 44, borderRadius: 12 }}>
            <Ic name="lock" size={20} />
          </span>
          <h1>{boot.title}</h1>
          <p>{boot.message}</p>
          {boot.retry ? (
            <button className="btn sm" onClick={() => window.location.reload()} data-autofocus>
              <Ic name="rotate-ccw" size={14} />
              Try again
            </button>
          ) : (
            <a className="btn sm" href="#demo" onClick={() => setTimeout(() => window.location.reload(), 0)}>
              Try the demo canvas
            </a>
          )}
        </div>
      </div>
    );
  if (blockView() && !boot.demo)
    return (
      <Suspense fallback={<Splash />}>
        <BlockEmbed session={boot.session} collab={boot.collab} />
      </Suspense>
    );
  return <Workspace key={gen} session={boot.session} collab={boot.collab} demo={boot.demo} onReboot={() => setGen((g) => g + 1)} />;
}

function Workspace({ session, collab, demo, onReboot }: { session: Session; collab: Collab; demo: Demo | null; onReboot(): void }) {
  const { doc, awareness } = collab;
  const hostName = session.host.name;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [role, setRole] = useState<Role>(session.role);
  const [forcedReadOnly, setForcedReadOnly] = useState(false);
  const [roleChanged, setRoleChanged] = useState(() => !demo && peekDowngraded(session.room) && session.role !== "edit");
  useEffect(() => clearDowngraded(session.room), [session.room]);
  // The modals and person cards load right after first paint (WEB-08), ready before they show.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void workspaceModals().catch(() => undefined);
      void import("./components/PersonCard").catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  // Had more than view access at some point in this Workspace (or the one before a reboot).
  const everEdited = useRef(session.role !== "view" || roleChanged);
  if (role !== "view") everEdited.current = true;
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: null });
  const [conn, setConn] = useState<"connected" | "reconnecting" | "offline">("connected");
  const [conflict, setConflict] = useState<{ policy: "copy" | "reload" | null; fileId?: string; url?: string; open: boolean } | null>(null);
  const [tempNote, setTempNote] = useState(() => !tempNoteHidden(session.room));
  const [closed, setClosed] = useState<{ kind: "revoked" | "host" | "other"; reason: string } | null>(null);
  // ADR-048: tell the host the session is over, so its own chrome can offer to reopen (MM S2j).
  const closedKind = closed?.kind ?? null;
  useEffect(() => {
    if (closedKind) postToHost("Error", { code: "SESSION_CLOSED", message: closedKind });
  }, [closedKind]);
  const reloading = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [screen, setScreen] = useState<"editor" | "gallery">("editor");
  const [side, setSide] = useState<"comments" | "history" | "automations" | "links" | "graph" | null>(null);
  // GRAPH-02: the full graph, over the editor (from the local panel or Action_OpenGraph).
  const [graphFull, setGraphFull] = useState(false);
  // VH-01d: bumped on every save and restore so an open history panel refreshes its list;
  // `nameReq` opens the naming popover from the menu; `previewing` hides the live canvas.
  const [historyTick, setHistoryTick] = useState(0);
  const [nameReq, setNameReq] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  // A naming request is for the panel it opened; reopening the panel later must not re-ask.
  useEffect(() => {
    if (side !== "history") setNameReq(0);
  }, [side]);
  const [active, setActive] = useState<string | null>(null);
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem("oc:wide") === "1";
    } catch {
      return false;
    }
  });
  const [following, setFollowing] = useState<string | null>(null);
  const [lastEditBy, setLastEditBy] = useState<string | null>(null);
  const [csv, setCsv] = useState<((csv: string) => void) | null>(null);
  const [urlAsk, setUrlAsk] = useState<{ kind: "bookmark" | "embed"; cb: (u: string) => void } | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmTpl, setConfirmTpl] = useState<(() => void) | null>(null);
  // TPL-01: a team template is applied by the server, so it is undone from its toast, not ⌘Z.
  const [confirmTeam, setConfirmTeam] = useState(false);
  const [team, setTeam] = useState<TeamState>(() => (teamEnabled(session) ? { s: "loading" } : { s: "off" }));
  const teamLoaded = useRef(false);
  const [help, setHelp] = useState(false);
  // SRCH-01: the find bar (`replace` opens the replace row; `tick` re-focuses it on ⌘F again).
  const [find, setFind] = useState<{ initial: string; replace: boolean; tick: number } | null>(null);
  const [searchAll, setSearchAll] = useState(false);
  const pendingThread = useRef<string | null>(null);
  const modified = useRef(false);

  // docs/23 PERM-07 (prototype Main.dc.html): access running out.
  const [access, setAccess] = useState<AccessState>("ok");
  const [exp, setExp] = useState<number | null>(session.demo ? null : session.exp ?? null);
  const accessRef = useRef(access);
  accessRef.current = access;
  const askRenew = useCallback(() => postToHost("Token_Expiring", { inSeconds: Math.max(0, Math.round((exp ?? 0) - Date.now() / 1000)) }), [exp]);
  useEffect(() => {
    const t = schedule(exp);
    if (!t) return;
    const ids = [
      window.setTimeout(() => postToHost("Token_Expiring", { inSeconds: WARN_S }), t.ask),
      window.setTimeout(() => setAccess((a) => (a === "ok" ? "warn" : a)), t.warn),
      window.setTimeout(() => setAccess("expired"), t.end),
    ];
    return () => ids.forEach((i) => window.clearTimeout(i));
  }, [exp]);
  useEffect(
    () =>
      onHost("Action_RefreshToken", (v) => {
        // OFF-04: a reconnect waits for this answer (a token, or `{access: "none"}`).
        if (reconnectToken.take) return reconnectToken.take(v);
        if (typeof v.token !== "string" || !v.token) return;
        void renewSession(v.token).then(
          (r) => {
            session.ticket = r.ticket;
            collab.retarget(r.ticket);
            const shown = accessRef.current !== "ok";
            setAccess("ok");
            setClosed((c) => (c && /expired/i.test(c.reason) ? null : c));
            setExp(r.exp);
            if (shown) toast("Access renewed. You can keep editing.", { icon: "check" });
          },
          () => postToHost("Error", { code: "TOKEN_REFRESH_FAILED", message: "The renewed token was refused" }),
        );
      }),
    [session, collab],
  );

  // OFF-02..06: offline copies (lazy controller), the pill's offline states and the stop-work states.
  const ov = useStore(offlineView);
  const offlineOn = !session.demo && (!!session.offline?.enabled || !!session.openedOffline);
  useEffect(() => {
    if (session.demo) return;
    const sync = () => {
      const v = offlineView.get();
      if (!v.kept) patchView({ pending: collab.pending.size, pendingBytes: collab.pending.bytes });
    };
    const offs = [
      collab.pending.version.subscribe(sync),
      // Session resilience for every host: the pill says where the changes are (1c).
      collab.onConn((c) => {
        if (offlineOn) return; // the controller decides (every reconnect is a fresh launch)
        patchView({ net: c === "connected" ? "online" : c === "offline" ? "offline" : "online", offlineSince: c === "offline" ? Date.now() : null });
      }),
    ];
    // docs/05 §4c: the host page hears the pill's state.
    let last = "";
    offs.push(
      offlineView.subscribe(() => {
        const v = offlineView.get();
        const state = v.locked ? "locked" : v.paused ? "paused" : v.net === "sending" ? "sending" : v.net === "reconnecting" ? "reconnecting" : v.net === "offline" ? (v.kept ? "offline-device" : "offline-tab") : "saved";
        const key = state + ":" + v.pending;
        if (key === last) return;
        last = key;
        postToHost("UI_OfflineState", { state, pending: v.pending });
      }),
    );
    window.addEventListener("beforeunload", leaveGuard);
    return () => {
      offs.forEach((f) => f());
      window.removeEventListener("beforeunload", leaveGuard);
    };
  }, [collab, session, offlineOn]);
  useEffect(() => {
    if (!offlineOn) return;
    // PSYNC-03 (owner decision): an offline copy holds the whole canvas, every part loaded.
    collab.parts?.pinAll();
    let stop: (() => void) | null = null;
    void import("./offline/controller").then(async (m) => {
      const c = await m.start(
        {
          session,
          collab,
          hostName,
          reboot: onReboot,
          setTicket: (t, e) => {
            session.ticket = t;
            setAssetTicket(t);
            setExp(e);
            try {
              const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
              h.delete("offline");
              h.delete("h");
              h.delete("u");
              h.delete("f");
              h.set("t", t);
              window.history.replaceState(null, "", "#" + h.toString());
            } catch {
              /* the next reboot reads the session again */
            }
          },
          nameOfClient: (client) => {
            const st = awareness.getStates().get(client) as { user?: { name?: string } } | undefined;
            return st?.user?.name?.split(" ")[0] ?? null;
          },
          toast: (t, o) => toast(t, o ?? {}),
        },
        !!session.openedOffline,
      );
      stop = () => c.destroy();
    });
    return () => stop?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab, session, offlineOn]);
  const offlineStop = ov.paused || ov.locked || ov.held > 0 || !!ov.revoked;

  const effectiveRole: Role = forcedReadOnly || conflict || closed || access === "expired" || offlineStop ? "view" : role;
  // docs/24 §10.2: the assistant shows only when the session's AI flag is on (or `?ai=1`, `#demo`).
  const ai = useMemo(() => aiAvailability(session, effectiveRole), [session, effectiveRole]);
  useEffect(() => aiStore.set(ai), [ai]);
  // FC-10: "Import…" in the slash and "…" menus, behind the host's import flag.
  const impFormats = useMemo(() => importFormats(session, effectiveRole), [session, effectiveRole]);
  // docs/30 §7, frame 7b: editors see history by default; others only with the host's `history`
  // perm. Without it there is no menu item at all. The server checks every call again.
  const canHistory = !session.demo && (session.perms.history ?? effectiveRole === "edit");
  const canHistoryRef = useRef(canHistory);
  canHistoryRef.current = canHistory;
  const canNameVersion =
    canHistory && effectiveRole === "edit" && session.storage !== "ephemeral" && session.history === "full" && session.perms.commitMessage !== false;
  useEffect(() => importStore.set({ formats: impFormats }), [impFormats]);
  const impOpen = useStore(importOpenStore);
  const [importInto, setImportInto] = useState(false);
  // DGM-14.6: "Import…" in diagram mode adds to that board.
  const [importBoard, setImportBoard] = useState<string | null>(null);
  const impSeen = useRef(impOpen);
  useEffect(() => {
    if (impOpen !== impSeen.current) {
      impSeen.current = impOpen;
      if (impFormats.length) setImportInto(true);
    }
  }, [impOpen, impFormats]);
  useEffect(() => () => aiStore.set({ on: false, modes: [] }), []);
  const meta = useMeta(doc);
  const lastEdit = useLastEdit(doc);
  const peers = usePeers(awareness);
  const threads = useThreads(doc);
  const openThreads = threads.filter((t) => !t.resolved).length;

  const me: OcUser = useMemo(
    () => ({ id: session.user.id, name: session.user.name, color: session.user.color, avatar: session.user.avatar ?? undefined, detail: session.user.detail }),
    [session.user],
  );

  // Template / picker icons: fetch right after first paint (the header may use one).
  useEffect(() => {
    const t = window.setTimeout(() => void loadExtraIcons(), 300);
    return () => window.clearTimeout(t);
  }, []);

  // ---------- layout ----------
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setRoot(el);
    // ADR-050: the phone/side-panel breakpoint is 45em (720 px at the default 16 px), so a
    // larger default font size switches to the compact layout sooner, like a media query.
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < compactBelow()));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------- people (docs/21: mentions, assignees, presence) ----------
  // docs/21 revision 2: the canvas's members, the same list for everyone with access.
  const people = useMemo(() => {
    const local = demo ? Object.values(demo.users).map(({ id, name, color }) => ({ id, name, color })) : undefined;
    const p = new People(
      {
        ticket: session.demo ? undefined : session.ticket,
        me,
        local,
      },
      doc,
    );
    // Set before the editor's first render, so mention chips show members' current names.
    setPeople(p);
    return p;
  }, [session, doc, demo, me]);
  useEffect(() => {
    setPeople(people);
    // The doc observer lives as long as the doc (StrictMode re-runs this effect).
    return () => setPeople(null);
  }, [people]);
  const peopleVersion = useSyncExternalStore(people.version.subscribe, people.version.get);
  useEffect(() => {
    people.setPeers(peers.filter((p) => !p.me && !p.agent).map((p) => ({ id: p.id, name: p.name, color: p.color, avatar: p.avatar ?? undefined, detail: p.detail })));
  }, [people, peers]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allUsers = useMemo(() => people.pickable(), [people, peopleVersion]);

  const searchUsers = useCallback((q: string): Promise<OcUser[]> => people.search(q), [people]);

  // docs/21 revision 2: a revoke changes the member list; refetch it without a reload.
  useEffect(() => collab.onControl((c) => c.t === "members" && void people.load()), [collab, people]);
  // AUTO-06 frame 3a: a rule ran on this person's change; Undo reverts the whole run.
  useEffect(
    () =>
      collab.onControl((c) => {
        if (c.t !== "automation-ran") return;
        toast(c.text, { icon: "zap", ms: 8000, action: { label: "Undo", run: () => collab.sendControl({ t: "automation-undo", runId: c.runId, ruleId: c.ruleId }) } });
      }),
    [collab],
  );

  // ---------- save state, connection, control channel ----------
  useEffect(() => {
    const offs = [
      collab.onControl((c) => {
        switch (c.t) {
          case "saving":
            setSave({ kind: "saving" });
            break;
          case "saved":
            setSave({ kind: "saved", at: c.at, version: c.version });
            setHistoryTick((n) => n + 1);
            postToHost("Doc_Saved", { commitId: c.version ?? null, hostVersion: c.version ?? null });
            if (modified.current) postToHost("Doc_ModifiedStatus", { Modified: false });
            modified.current = false;
            break;
          case "save_error":
            setSave({ kind: "error", message: c.message, retryInMs: c.retryInMs });
            postToHost("Error", { code: "SAVE_FAILED", message: c.message ?? "Save failed" });
            break;
          case "conflict":
            if (c.policy === "reload") {
              // `closed` + close 1012 follow; then we start over from the host's version.
              reloading.current = true;
              postToHost("Error", { code: "CONFLICT", message: "The file changed outside this session. Reloading the latest version." });
              break;
            }
            // `copy` (or an older server without a policy): the room stays read-only.
            setConflict((prev) => (prev && prev.policy === (c.policy ?? null) ? prev : { policy: c.policy ?? null, fileId: c.fileId, url: c.url, open: true }));
            postToHost("Error", { code: "CONFLICT", message: "The file changed outside this session" });
            break;
          case "role":
            // Live role change from the host (docs/15 §6 role API): no reload needed.
            setRole((prev) => {
              if (prev === c.role) return prev;
              const rank = { view: 0, comment: 1, edit: 2 } as const;
              if (rank[c.role] < rank[prev]) setRoleChanged(true);
              else {
                setRoleChanged(false);
                toast(c.role === "edit" ? `${hostName} gave you edit access` : `${hostName} gave you comment access`, { icon: c.role === "edit" ? "pen-tool" : "message-square-plus" });
              }
              return c.role;
            });
            awareness.setLocalStateField("role", c.role);
            break;
          case "restored":
            setHistoryTick((n) => n + 1);
            // 6b: a toast, not a modal; the person who restored gets theirs (with Undo) from the panel.
            if (c.by !== session.user.id)
              toast(restoredText(c), {
                avatar: { name: c.byName ?? "Someone", color: people.get(c.by).color },
                ms: 8000,
                action: canHistoryRef.current ? { label: "View", run: () => setSide("history") } : undefined,
              });
            break;
          case "offline_arrived":
            // OFF-07 (frame 4e): one toast when a long offline session arrives.
            if (c.by !== session.user.id)
              toast(`${c.byName?.split(" ")[0] ?? "Someone"} was offline. ${c.changes ? `Their ${c.changes} changes` : "Their changes"} just arrived.`, {
                avatar: { name: c.byName ?? "Someone", color: people.get(c.by).color },
                ms: 8000,
                action: canHistoryRef.current ? { label: "See changes", run: () => setSide("history") } : undefined,
              });
            break;
          case "closed": {
            const reason = c.reason ?? "";
            if (reloading.current) break; // handled by the 1012 that follows
            if (/shutting down/i.test(reason)) break; // server restart: the provider reconnects
            setClosed({ kind: /revoked/i.test(reason) ? "revoked" : /host/i.test(reason) ? "host" : "other", reason });
            break;
          }
        }
      }),
      collab.onTerminal((e) => {
        if (reloading.current) {
          reloading.current = false;
          toast(`Loaded the latest version from ${hostName}`, { icon: "rotate-ccw" });
          onReboot();
          return;
        }
        // PERM-07: the server ends the session at its `exp`; that is the read-only bar, not "closed".
        if (/session expired/i.test(e.reason)) return setAccess("expired");
        setClosed((prev) => prev ?? { kind: e.code === 1008 ? "revoked" : "host", reason: e.reason });
      }),
      collab.onConn((s) => {
        if (s === "connected") setConn("connected");
        else if (s === "offline") setConn("offline");
        else setConn("reconnecting");
      }),
      collab.onDenied(() => {
        // The server refused local changes (a downgrade raced unsynced edits, or a forced
        // write): they never sync, so start over from the room's state rather than keep
        // showing text nobody else has (docs/06 §4, docs/23 PERM-03).
        if (!demo) {
          if (everEdited.current) markDowngraded(session.room);
          onReboot();
          return;
        }
        setRole((prev) => {
          if (prev === "edit") setRoleChanged(true);
          return prev === "edit" ? "view" : prev;
        });
      }),
    ];
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      const remote = origin === collab.provider || origin === "lin" || origin === "demo";
      if (remote) {
        const typer = peersRef.current.find((p) => !p.me && p.typing);
        setLastEditBy(typer ? typer.name.split(" ")[0] : null);
        return;
      }
      setLastEditBy(null);
      setSave((s) => (s.kind === "saved" ? { kind: "unsaved" } : s));
      if (!modified.current) postToHost("Doc_ModifiedStatus", { Modified: true });
      modified.current = true;
    };
    doc.on("update", onUpdate);
    return () => {
      offs.forEach((f) => f());
      doc.off("update", onUpdate);
    };
  }, [collab, doc]);

  const peersRef = useRef<Peer[]>(peers);
  peersRef.current = peers;

  useEffect(() => {
    postToHost("Presence_Changed", { users: peers.map((p) => ({ id: p.id, name: p.name, color: p.color, role: p.role, ...(p.detail ? { detail: p.detail } : {}) })) });
  }, [peers]);

  // ---------- host page commands ----------
  const titleRef = useRef("");
  titleRef.current = meta.title || session.file.name;
  const doExport = useCallback(
    (fmt: string) => {
      if (!EXPORTS.has(fmt)) return;
      const f = fmt as ExportFormat;
      const allowed = f === "ocanvas" ? session.perms.download !== false : session.perms.export !== false;
      if (!allowed) return toast("Exports are turned off for this canvas", { icon: "lock" });
      if (session.demo && f === "pdf") return void import("./lib/exports").then((m) => m.printPdf());
      if (session.demo) return toast("Exports download from the server. They're not available in the demo.", { icon: "download" });
      void import("./lib/exports").then((m) => m.downloadExport(session.ticket, f, titleRef.current));
    },
    [session],
  );

  useEffect(() => {
    const offs = [
      onHost("Host_PostmessageReady", () => postToHost("App_LoadingStatus", { Status: "Document_Loaded" })),
      // LIVE-03 (1e): the host's picker answers with `Action_InsertLiveBlock {fileId}`.
      installLiveHost(),
      onHost("Action_SetReadOnly", (v) => setForcedReadOnly(!!v.readOnly)),
      onHost("Action_Commit", (v) => collab.sendControl({ t: "save", message: v.message ?? null })),
      onHost("Action_Export", (v) => doExport(String(v.format ?? "md"))),
      // GRAPH-02 (docs/38 §3.2): the host's navigation opens the full graph; with links off it
      // says why (6b).
      onHost("Action_OpenGraph", () => setGraphFull(true)),
      // FTY-03 (docs/05 §4): with `[host.editor] chrome = "host"` the host's header opens the panels.
      onHost("Action_OpenPanel", (v) => {
        const p = String(v.panel ?? "");
        if (p === "history" && canHistoryRef.current) setSide((s) => (s === "history" ? null : "history"));
        if (p === "comments" && featureOn("comments")) setSide((s) => (s === "comments" ? null : "comments"));
        if (p === "find") openFindRef.current?.(false);
        if (p === "graph" && linksOnRef.current) setSide((s) => (s === "graph" ? null : "graph"));
        if (p === "shortcuts") setHelp(true);
      }),
      onHost("Action_Theme", (v) => {
        const t = v.theme;
        if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
        else delete document.documentElement.dataset.theme;
      }),
    ];
    postToHost("App_LoadingStatus", { Status: "Document_Loaded" });
    return () => offs.forEach((f) => f());
  }, [collab, doExport]);

  // ---------- first open ----------
  const seeded = useRef(false);
  useEffect(() => {
    if (!editor || seeded.current) return;
    seeded.current = true;
    if (demo && editor.isEmpty) {
      void demo
        .seed((json) => editor.commands.setContent(json))
        .then(() => {
          yUndoPluginKey.getState(editor.state)?.undoManager.clear();
          const sim = new URLSearchParams(window.location.hash.slice(1)).get("sim");
          if (sim) window.setTimeout(() => demo.simulate(sim), 300);
          window.setTimeout(() => toast("Lin is typing in Decisions", { avatar: { name: "Lin Zhou", color: demo.users.lin.color } }), 2400);
        });
      return;
    }
    if (role === "edit" && !meta.title && session.file.name) setMeta(doc, { title: session.file.name }, null);
    // A temporary canvas (a meeting's shared document) opens blank: people join it mid-meeting
    // and expect to type at once. A host that already asked for the kind launches with
    // `"start": "page"` (ADR-048). Templates stay one click away on the blank page.
    if (featureOn("templates") && showsGallery({ isNew: session.isNew, storage: session.storage, role, empty: editor.isEmpty, hash: window.location.hash })) setScreen("gallery");
    // FTY-02 (docs/05 §2f): a new typed file gets its one root block, made by the first editor
    // to open it; the file then reopens as that block. Full-page app chrome is FTY-03..05.
    const app = resolveApp(window.location.hash, (session as { app?: string }).app, meta.app);
    if (app) {
      document.documentElement.dataset.app = app;
      // The root block is the file; anything else opens as a document, unchanged (§2f).
      let told = false;
      const find = () => {
        const r = appRootOf(editor.getJSON(), app);
        if ("id" in r) {
          setAppRoot(r.id);
          document.documentElement.dataset.appRoot = "1";
          postToHost("UI_AppMode", { app, fallback: null });
        } else if ("fallback" in r) {
          setAppRoot(null);
          delete document.documentElement.dataset.appRoot;
          if (!told) {
            told = true;
            postToHost("UI_AppMode", { app: "document", fallback: r.fallback });
            toast(`This ${app} has other content, so it opened as a document`, { icon: "info" });
          }
        }
      };
      find();
      editor.on("update", find);
    }
    if (app && role === "edit" && editor.isEmpty && session.isNew) {
      // The file records its type (manifest `type`), so it reopens the same way anywhere.
      setMeta(doc, { app }, null);
      if (app === "whiteboard") start("boardblank");
      else if (app === "database") start("dbblank");
      else
        void import("./editor/blockdata")
          .then((m) => m.loadSheet())
          .then((m) => editor.commands.setContent({ type: "doc", content: [{ type: "spreadsheet", attrs: { sheetId: m.createSheetBlock(doc)[0] } }, { type: "paragraph" }] }))
          .catch(() => toast("The spreadsheet couldn't load. Check your connection and reload.", { icon: "triangle-alert" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // `#demo` only: expose the editor so the browser suite can drive it (never in a real session).
  useEffect(() => {
    if (!session.demo || !editor) return;
    (window as unknown as { __ocEditor?: Editor }).__ocEditor = editor;
  }, [session.demo, editor]);

  // ---------- undo across blocks (docs/06 §4) ----------
  // One undo stack for your own changes: text (y-prosemirror), database cells and the
  // header (title, icon, colour). Collaborators' changes are never undone.
  useEffect(() => {
    if (!editor) return;
    const um = yUndoPluginKey.getState(editor.state)?.undoManager;
    if (!um) return;
    um.addToScope([doc.getMap("meta"), doc.getMap("databases")]);
    um.trackedOrigins.add(META_ORIGIN);
    // PSYNC-03: parts are documents of their own; one stack still steps through all of them.
    collab.parts?.linkUndo(um);
    let off = false;
    loadDatabase()
      .then((m) => !off && um.trackedOrigins.add(m.DB_ORIGIN))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [editor, doc]);

  // ---------- deep links to a block: `#...&block=b_...` or the host's Action_ScrollToBlock ----------
  // GRAPH-02: Enter or a double-click opens a canvas through the host (decision 9).
  const openFromGraph = (fileId: string, blockId: string | null) => {
    if (fileId !== session.file.id) postToHost("UI_OpenFile", { fileId, ...(blockId ? { blockId } : {}), newTab: false });
    else if (blockId) scrollToBlock(blockId);
  };
  const scrollToBlock = useCallback(
    (id: string) => {
      if (!editor || !flashBlock(editor, id)) toast("That block isn't in this canvas any more", { icon: "link" });
    },
    [editor],
  );
  useEffect(() => {
    if (!editor) return;
    // BRD-21: `&shape=<id>` (Copy link to shape) also opens the board at that shape. A board that
    // mounts later reads it from the hash itself (`@opencanvas/board`, SHAPE_EVENT).
    const showShape = (shapeId: unknown) => typeof shapeId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(shapeId) && window.dispatchEvent(new CustomEvent("oc-board-shape", { detail: { shapeId } }));
    const { blockId: id, shapeId } = linkTarget(window.location.hash);
    const t = id ? window.setTimeout(() => (scrollToBlock(id), showShape(shapeId)), 600) : undefined;
    // TALK-01 Follow me: `follow: true` scrolls quietly (no flash, no toast for a missing block).
    const off = onHost("Action_ScrollToBlock", (v) => typeof v.blockId === "string" && (v.follow === true ? followScroll(editor, v.blockId) : (scrollToBlock(v.blockId), showShape(v.shapeId))));
    let stopReport: (() => void) | null = null;
    const offView = onHost("Action_FollowView", (v) => {
      stopReport?.();
      stopReport = v.on === true ? reportView(editor, (blockId) => postToHost("UI_ViewBlock", { blockId })) : null;
    });
    return () => {
      window.clearTimeout(t);
      off();
      offView();
      stopReport?.();
    };
  }, [editor, scrollToBlock]);

  // ---------- find in this canvas (SRCH-01) and search across canvases (SRCH-04) ----------
  const openFind = useCallback(
    (replace: boolean) => {
      let initial = "";
      if (editor && !editor.state.selection.empty) {
        const { from, to } = editor.state.selection;
        const t = editor.state.doc.textBetween(from, to, "\n");
        if (t && !t.includes("\n") && t.length <= 200) initial = t;
      }
      setFind((f) => ({ initial: initial || f?.initial || "", replace, tick: (f?.tick ?? 0) + 1 }));
    },
    [editor],
  );
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  const searchOn = !!session.search?.enabled && !session.demo;
  const linksOn = !!session.links?.enabled && !session.demo;
  const linksOnRef = useRef(linksOn);
  linksOnRef.current = linksOn;
  // AUTO-06: rules in this canvas (counted for the menu, also when the host runs none, frame 5d).
  const autoOn = !!session.automation?.enabled && !!session.automation.limits && !session.demo;
  const [ruleCount, setRuleCount] = useState(0);
  const autoEdit = autoOn && !!session.automation?.canEdit && effectiveRole === "edit";
  // Frame 1c: the database header's Automate menu and "When this is checked…" open the editor
  // with the trigger filled in.
  const [autoStart, setAutoStart] = useState<{ trigger: Record<string, unknown> } | null>(null);
  const [dbMenu, setDbMenu] = useState<{ dbId: string; anchor: HTMLElement } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<{ trigger: Record<string, unknown> }>).detail?.trigger;
      if (!t || !autoEdit) return;
      setAutoStart({ trigger: t });
      setSide("automations");
    };
    window.addEventListener("oc:automate", on);
    return () => window.removeEventListener("oc:automate", on);
  }, [autoEdit]);
  const rulesOf = useCallback(
    (dbId: string) => {
      const out: { id: string; name: string; on: boolean }[] = [];
      doc.getMap("automations").forEach((v, id) => {
        const o = (v && typeof (v as { toJSON?: unknown }).toJSON === "function" ? (v as { toJSON(): unknown }).toJSON() : v) as { name?: string; enabled?: boolean; paused?: unknown; trigger?: { database?: string } };
        if (o?.trigger?.database === dbId) out.push({ id, name: o.name || "Untitled rule", on: !!o.enabled && !o.paused });
      });
      return out;
    },
    [doc],
  );
  useEffect(() => {
    const m = doc.getMap("automations");
    const count = () => setRuleCount(m.size);
    count();
    m.observe(count);
    return () => m.unobserve(count);
  }, [doc]);
  const searchOnRef = useRef(searchOn);
  searchOnRef.current = searchOn;

  // ---------- keyboard shortcuts help: `?` outside text, Mod-Shift-/ anywhere ----------
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inText = !!t?.closest?.("input,textarea,select,[contenteditable=true]");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === "j" || e.key === "J" || e.code === "KeyJ") && aiStore.get().on) {
        e.preventDefault();
        openAssistant();
        return;
      }
      // VH-01d frame 1a: ⌥⌘H (Ctrl+Alt+H elsewhere) opens or closes Version history.
      if (mod && e.altKey && !e.shiftKey && e.code === "KeyH") {
        if (!canHistoryRef.current) return;
        e.preventDefault();
        setSide((s) => (s === "history" ? null : "history"));
        return;
      }
      // SRCH-01: ⌘F / Ctrl+F opens our find while focus is in the canvas (not in a side panel
      // or dialog: the browser's own find works there); ⌘⌥F / Ctrl+H opens replace.
      // SRCH-04: ⌘⇧F / Ctrl+Shift+F searches all canvases when the host can.
      if (mod && e.code === "KeyF" && !e.shiftKey) {
        if (t?.closest?.(".side, [role=dialog], .vh-panel")) return;
        e.preventDefault();
        openFindRef.current(e.altKey);
        return;
      }
      if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyH") {
        if (t?.closest?.(".side, [role=dialog]")) return;
        e.preventDefault();
        openFindRef.current(true);
        return;
      }
      if (mod && e.shiftKey && e.code === "KeyF" && searchOnRef.current) {
        e.preventDefault();
        setSearchAll(true);
        return;
      }
      if ((mod && e.shiftKey && (e.code === "Slash" || e.key === "?")) || (!inText && !mod && !e.altKey && e.key === "?")) {
        e.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // ---------- bridge for node views & editor plugins ----------

  const failedOnce = useRef(false);
  const upload = useCallback(
    async (f: File, onProgress?: (p: number) => void): Promise<Uploaded> => {
      if (session.demo) {
        // No server in the demo: simulate the transfer, then keep the bytes inline.
        // `#demo&sim=uploadfail` fails the first attempt to show the retry chip.
        for (let p = 0.1; p < 1; p += 0.15) {
          onProgress?.(p);
          await new Promise((r) => window.setTimeout(r, 120));
        }
        if (/sim=uploadfail/.test(window.location.hash) && !failedOnce.current) {
          failedOnce.current = true;
          throw new Error("simulated failure");
        }
        const url = await new Promise<string>((res, rej) => {
          if (f.size > 4 * 1024 * 1024) return res(URL.createObjectURL(f));
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        onProgress?.(1);
        return { url, mime: f.type, size: f.size, name: f.name };
      }
      // XHR rather than fetch: fetch can't report upload progress.
      return new Promise<Uploaded>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open("POST", `/v1/assets?ticket=${encodeURIComponent(session.ticket)}`);
        x.responseType = "json";
        x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
        x.onload = () => {
          const j = x.response as { url?: string; mime?: string; size?: number } | null;
          if (x.status < 200 || x.status >= 300 || !j?.url) return reject(new Error("upload failed " + x.status));
          onProgress?.(1);
          resolve({ url: j.url, mime: j.mime ?? f.type, size: j.size ?? f.size, name: f.name });
        };
        x.onerror = () => reject(new Error("network"));
        x.onabort = () => reject(new Error("aborted"));
        const fd = new FormData();
        fd.append("file", f, f.name);
        x.send(fd);
      });
    },
    [session],
  );
  // Blocks (board images, …) store files through the same host proxy (BlockEnv.upload).
  // The editor's undo manager (y-prosemirror) is the canvas's one undo stack (docs/06 §4): database
  // and board blocks add their edits to it, so ⌘Z / ⌘⇧Z step through text, cells and shapes in order.
  const undoManager = useMemo(() => (editor ? yUndoPluginKey.getState(editor.state)?.undoManager : undefined), [editor]);
  const env: BlockEnv = useMemo(
    () => ({
      role: effectiveRole, me, users: allUsers, person: (id: string) => people.get(id), compact, toast: (m, action) => toast(m, { action }), upload: (f: File) => upload(f), resolveAsset, undoManager, maxDocBytes: session.maxDocBytes,
      exportBoard: session.demo ? undefined : (id, fmt, ids) => exportBoardText(session.ticket, id, fmt, ids),
      importToBoard: impFormats.some((f) => DIAGRAM_FORMATS.includes(f)) ? (id) => (setImportBoard(id), setImportInto(true)) : undefined,
      // DGM-17: Add your own icon, cleaned by the server (demo: the local doc stands in for the room).
      icons: session.demo ? demoIcons(doc, me) : serverIcons(session.ticket),
      // EDP-01: `[host.editor.features] diagramming`.
      diagramming: featureOn("diagramming"),
      // ADR-078: formula, relation and rollup fields (`[host.flags] formulas`; on in the demo).
      formulas: !!session.formulas || !!session.demo,
      // AUTO-06 frame 1c: the database header's Automate button (editors who may automate).
      automations: autoEdit ? (id: string) => rulesOf(id).length : undefined,
      automate: autoEdit ? (id: string, anchor: HTMLElement) => setDbMenu({ dbId: id, anchor }) : undefined,
      // SHEET-06 (4h, 8a): charts and spreadsheet ⇄ database, placed after the block (loaded on use).
      ...(effectiveRole === "edit" && editor ? blockActions(editor, doc, (id) => (collab.parts?.isPart(id) ? collab.parts.doc(id) : null) ?? doc, () => allUsers, (m) => toast(m)) : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveRole, me, allUsers, people, compact, upload, undoManager, session.demo, session.ticket, impFormats, session.maxDocBytes, session.formulas, doc, autoEdit, ruleCount, editor, collab],
  );

  const openThread = useCallback((id: string) => {
    setSide("comments");
    setActive(id);
  }, []);

  const bridgeValue: Bridge = useMemo(
    () => ({
      doc,
      parts: collab.parts,
      awareness,
      env,
      session,
      importCsv: (cb) => setCsv(() => cb),
      promptUrl: (kind, cb) => setUrlAsk({ kind, cb }),
      pickFile: (accept, cb) => {
        const i = document.createElement("input");
        i.type = "file";
        i.accept = accept;
        i.onchange = () => i.files?.[0] && cb(i.files[0]);
        i.click();
      },
      upload,
      openThread,
      linkClick: (url) => postToHost("UI_Link_Click", { url }),
    }),
    [doc, awareness, env, session, upload, openThread],
  );
  setBridge(bridgeValue);

  // ---------- comments ----------
  const removeMarks = useCallback(
    (id: string) => {
      if (!editor || effectiveRole !== "edit") return;
      const type = editor.schema.marks.commentMark;
      const tr = editor.state.tr;
      editor.state.doc.descendants((n, pos) => {
        n.marks.forEach((m) => m.type === type && m.attrs.threadId === id && tr.removeMark(pos, pos + n.nodeSize, m));
      });
      if (tr.docChanged) editor.view.dispatch(tr);
    },
    [editor, effectiveRole],
  );
  const dropIfEmpty = useCallback(
    (id: string | null) => {
      if (!id || pendingThread.current !== id) return;
      const t = threads.find((x) => x.id === id);
      if (t && !t.messages.length) {
        removeMarks(id);
        deleteThread(doc, id);
      }
      pendingThread.current = null;
    },
    [threads, removeMarks, doc],
  );
  const onComment = useCallback(
    (id: string) => {
      dropIfEmpty(pendingThread.current);
      pendingThread.current = id;
      setSide("comments");
      setActive(id);
    },
    [dropIfEmpty],
  );
  const closeSide = () => {
    dropIfEmpty(pendingThread.current);
    setSide(null);
    setActive(null);
  };
  const jump = (id: string) => {
    setActive(id);
    const blk = threads.find((t) => t.id === id)?.block;
    const el = scrollRef.current?.querySelector(blk ? `.oc-ext[data-ext-block="${CSS.escape(blk)}"]` : `.cmt[data-thread="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (compact) setSide(null);
  };
  const threadCss = useMemo(
    () =>
      threads
        .filter((t) => t.resolved)
        .map((t) => `.ProseMirror .cmt[data-thread="${CSS.escape(t.id)}"]{background:none;border-bottom:0;cursor:text}`)
        .join("") +
      (active && side ? `.ProseMirror .cmt[data-thread="${CSS.escape(active)}"]{background:color-mix(in srgb,var(--amber-fg) 30%,transparent)}` : "") +
      // Decision 5: the open thread's SDK block gets the amber outline of the active comment.
      (() => {
        const blk = active && side ? threads.find((t) => t.id === active)?.block : undefined;
        return blk ? `.ProseMirror .oc-ext[data-ext-block="${CSS.escape(blk)}"] .oc-ext-frame{outline:2px solid color-mix(in srgb,var(--amber-fg) 70%,transparent);outline-offset:2px}` : "";
      })(),
    [threads, active, side],
  );

  // ---------- follow mode ----------
  const follow = useCallback(
    (p: Peer, start?: boolean) => {
      if (p.agent) {
        const el = scrollRef.current?.querySelector(".ai-touch, .ai-new");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        else toast("The assistant is working on this canvas", { icon: "sparkles" });
        return;
      }
      if (following === p.id) {
        if (!start) setFollowing(null);
        return;
      }
      const target = scrollRef.current?.querySelector(`.collaboration-carets__caret[data-uid="${CSS.escape(p.id)}"]`);
      const board = awareness.getStates().get(p.clientId)?.board as { id?: string } | undefined;
      const el = target ?? (board ? scrollRef.current?.querySelector(board.id ? `[data-board="${CSS.escape(board.id)}"]` : "[data-board]") : null);
      if (!el) {
        toast(p.role === "view" ? `${p.name.split(" ")[0]} is viewing the canvas` : `${p.name.split(" ")[0]} isn't editing right now`, { avatar: { name: p.name, color: p.color } });
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setFollowing(p.id);
      toast(`Following ${p.name.split(" ")[0]}. Scroll to stop.`, { avatar: { name: p.name, color: p.color } });
    },
    [following, awareness],
  );
  useEffect(() => {
    if (!following) return;
    const sc = scrollRef.current;
    const stop = () => setFollowing(null);
    const track = () => {
      const el = sc?.querySelector(`.collaboration-carets__caret[data-uid="${CSS.escape(following)}"]`);
      if (!el || !sc) return;
      const r = el.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      if (r.top < sr.top + 60 || r.bottom > sr.bottom - 60) el.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    awareness.on("change", track);
    sc?.addEventListener("wheel", stop, { passive: true });
    sc?.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("keydown", stop);
    return () => {
      awareness.off("change", track);
      sc?.removeEventListener("wheel", stop);
      sc?.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [following, awareness]);

  // ---------- templates & starts ----------
  const applyBlocks = useCallback(
    (blocks: TB[], m: { title: string; icon: string; tone: string; template: string }) => {
      if (!editor) return;
      const run = async () => {
        let content;
        try {
          const { buildDoc } = await import("./editor/content");
          content = await buildDoc(blocks, { doc, me: { id: me.id, name: me.name } });
        } catch {
          return toast("That template couldn't load. Check your connection and try again.", { icon: "triangle-alert" });
        }
        setMeta(doc, { title: m.title, icon: m.icon, tone: m.tone as never, template: m.template });
        editor.commands.setContent(content);
        setScreen("editor");
        scrollRef.current?.scrollTo({ top: 0 });
        window.setTimeout(() => {
          if (!compact) editor.commands.focus("start");
        }, 50);
      };
      if (editor.isEmpty) void run();
      else setConfirmTpl(() => () => void run());
    },
    [editor, doc, me, compact],
  );
  const pickTemplate = (t: Template) => {
    applyBlocks(t.blocks, { title: !meta.title || meta.template ? t.name : meta.title, icon: t.icon, tone: t.tone, template: t.id });
    toast(`Started from “${t.name}”`, { icon: "layout-template" });
  };
  const loadTeam = useCallback(() => {
    if (!teamEnabled(session)) return;
    teamLoaded.current = true;
    setTeam({ s: "loading" });
    teamApi().then((m) => m.loadTeamTemplates(session.ticket)).then(
      (items) => setTeam(items ? { s: "ready", items } : { s: "off" }),
      (e: unknown) => setTeam({ s: "error", message: e instanceof Error ? e.message : "" }),
    );
  }, [session]);
  useEffect(() => {
    if (screen === "gallery" && !teamLoaded.current) loadTeam();
  }, [screen, loadTeam]);
  const pickTeam = (t: TeamItem) => {
    if (!editor) return;
    const run = async () => {
      try {
        const r = await (await teamApi()).applyTeamTemplate(session.ticket, t.id);
        setScreen("editor");
        scrollRef.current?.scrollTo({ top: 0 });
        toast(`Started from “${r.name || t.name}”`, {
          icon: "layout-template",
          action: {
            label: "Undo",
            run: () =>
              void teamApi().then((m) => m.undoTeamTemplate(session.ticket, r.applyId)).then(
                () => toast("Template removed", { icon: "layout-template" }),
                (e: unknown) => toast(e instanceof Error ? e.message : "That template can no longer be undone.", { icon: "triangle-alert" }),
              ),
          },
        });
      } catch (e) {
        toast(e instanceof Error && e.message ? e.message : "That template couldn't be used. Try again.", { icon: "triangle-alert" });
      }
    };
    if (editor.isEmpty) void run();
    else (setConfirmTeam(true), setConfirmTpl(() => () => void run()));
  };
  const start = (k: "blank" | "dbblank" | "boardblank" | "import") => {
    if (k === "import") return setImporting(true);
    const map: Record<string, [string, string, TB[]]> = { blank: ["file-text", "gray", [{ k: "p", html: "" }]], dbblank: ["database", "blue", [{ k: "db", preset: "blank" }]], boardblank: ["shapes", "purple", [{ k: "board", preset: "blank" }]] };
    const [icon, tone, blocks] = map[k];
    applyBlocks(blocks, { title: meta.title, icon, tone, template: k });
  };
  const doImport = (r: ImportResult) => {
    if (!editor) return;
    const run = async () => {
      try {
        if (r.kind === "csv") {
          const { importCsvToDatabase } = await loadDatabase();
          const id = importCsvToDatabase(doc, r.text, r.name);
          editor.commands.setContent({ type: "doc", content: [{ type: "database", attrs: { dbId: id } }, { type: "paragraph" }] });
          setMeta(doc, { title: r.name, icon: "database", tone: "green", template: "import" });
        } else {
          const html = r.kind === "md" ? ((await import("marked")).marked.parse(r.text, { async: false }) as string) : r.text;
          editor.commands.setContent(html);
          setMeta(doc, { title: r.name, icon: "file-text", tone: "green", template: "import" });
        }
      } catch {
        return toast("The import didn't work. Check your connection and try again.", { icon: "triangle-alert" });
      }
      setScreen("editor");
      toast(`Imported “${r.name}”`, { icon: "upload" });
    };
    if (editor.isEmpty) void run();
    else setConfirmTpl(() => () => void run());
  };

  // ---------- empty canvas invitations ----------
  const emptyActions: EmptyAction[] = useMemo(
    () => [
      { id: "tpl", icon: "layout-template", label: "Templates", run: () => setScreen("gallery") },
      { id: "db", icon: "database", label: "Database", run: () => start("dbblank") },
      { id: "board", icon: "shapes", label: "Whiteboard", run: () => start("boardblank") },
      { id: "import", icon: "upload", label: "Import", run: () => start("import") },
      // EDP-01: the host's editor profile and feature switches (profile.ts).
    ].filter((a) => (a.id === "tpl" ? featureOn("templates") : insertable({ id: a.id }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, meta.title, compact],
  );

  // ---------- derived ----------
  // ADR-043: nothing is saved in a temporary canvas, so never say "Saved".
  const temporary = session.storage === "ephemeral";
  // ADR-049: the host's wording for a temporary canvas (meeting by default, room for Matrix).
  const words = temporaryWording(wordingOf(session.wording));
  const shownSave: SaveState =
    access === "expired" ? { kind: "ended" } : conflict || closed ? { kind: "paused" } : conn === "offline" ? { kind: "offline" } : conn === "reconnecting" ? { kind: "reconnecting" } : temporary && save.kind !== "readonly" ? { kind: "temporary" } : session.demo && save.kind !== "readonly" ? { kind: "demo" } : save;
  // A temporary (meeting) canvas has no place in the host to name: no breadcrumb parent.
  const parent = session.demo ? "Engineering" : session.storage === "ephemeral" ? "" : hostName;

  const banners: React.ReactNode[] = [];
  if (access === "warn")
    banners.push(
      <div key="access-warn" role="status" className="banner warn access">
        <Ic name="clock" />
        <span>
          <strong>Your access to this canvas ends in 1 minute.</strong> We asked {hostName} to renew it. Nothing you type is lost either way.
        </span>
        <button className="btn sm line" onClick={askRenew}>
          Renew now
        </button>
        <button className="btn sm link" onClick={() => setAccess("expired")}>
          Let it end
        </button>
      </div>,
    );
  if (access === "expired") {
    const at = savedAtLabel(save.kind === "saved" ? save.at : null);
    banners.push(
      <div key="access-ended" role="alert" className="banner bad access">
        <Ic name="lock" />
        <span>
          <strong>Your access ended, so the canvas is read only.</strong> {at ? `Your last changes were saved at ${at}.` : "Your changes are kept on this page."} Reconnect to keep editing.
        </span>
        <button className="btn sm pri" onClick={askRenew}>
          Reconnect
        </button>
      </div>,
    );
  }
  if (temporary && tempNote && !closed)
    banners.push(
      <div key="temporary" role="note" className="banner temp">
        <Ic name="info" />
        <span>{words.note}</span>
        <button
          className="ib sm"
          aria-label="Hide this note"
          title="Hide this note"
          onClick={() => {
            setTempNote(false);
            try {
              sessionStorage.setItem(tempNoteKey(session.room), "1");
            } catch {
              /* storage blocked: hidden until reload */
            }
          }}
        >
          <Ic name="x" size={14} />
        </button>
      </div>,
    );
  const copyName = `${meta.title || session.file.name || "Untitled"} (copy)`;
  const openCopy = () => conflict?.url && postToHost("UI_Link_Click", { url: conflict.url, fileId: conflict.fileId ?? null });
  if (conflict)
    banners.push(
      <div key="conflict" className="banner warn">
        <Ic name="triangle-alert" />
        <span>
          {conflict.policy === "copy" ? `This canvas changed in ${hostName}. Your version was saved as “${copyName}”.` : `This canvas changed in ${hostName}. Autosave is paused.`}
        </span>
        {conflict.policy === "copy" && conflict.url ? (
          <button className="btn sm" onClick={openCopy}>
            Open the copy
          </button>
        ) : null}
      </div>,
    );
  // Locked, paused or revoked offline copies say why in their own banner (5b-5d).
  if (effectiveRole === "view" && !roleChanged && !conflict && !closed && access !== "expired" && !ov.locked && !ov.paused && !ov.revoked)
    banners.push(
      <div key="view" className="banner info">
        <Ic name="eye" />
        <span>{forcedReadOnly ? "This canvas is read-only right now." : temporary && words.viewOnly ? words.viewOnly : `You can view this canvas. Ask in ${hostName} for edit access.`}</span>
      </div>,
    );
  if (effectiveRole === "comment")
    banners.push(
      <div key="comment" className="banner info">
        <Ic name="message-square-plus" />
        <span>You can comment. Select text to start a thread.</span>
      </div>,
    );
  if (roleChanged)
    banners.push(
      <div key="downgrade" className="banner warn">
        <Ic name="lock" />
        <span>{hostName} changed your access to {role === "comment" ? "comment only" : "view only"}. Edits that hadn't synced weren't kept.</span>
      </div>,
    );
  // OFF-06: offline is a state of the save pill, not a banner; banners only stop work (5a, 5c, 5d).
  if (offlineOn && (ov.held || ov.locked || ov.paused))
    banners.push(
      <Suspense key="offline" fallback={null}>
        <OfflineBanners hostName={hostName} title={meta.title || session.file.name} canDownload={session.perms.download !== false} />
      </Suspense>,
    );
  if (save.kind === "error" && conn === "connected")
    banners.push(
      <div key="savefail" className="banner bad">
        <Ic name="triangle-alert" />
        <span>{hostName} isn't accepting saves right now. Your changes are safe and we keep retrying.</span>
        <button className="btn sm" onClick={() => collab.sendControl({ t: "save" })}>
          Retry now
        </button>
      </div>,
    );

  const shell = useMemo(() => ({ root, compact }), [root, compact]);
  // FTY-03: the host draws the file header (`[host.editor] chrome = "host"`), so no top bar here.
  const hostChrome = profileStore.get()?.chrome === "host";

  return (
    <ShellCtx.Provider value={shell}>
      <BridgeCtx.Provider value={bridgeValue}>
        <div className={"app oc-root" + (compact ? " compact" : "") + (effectiveRole !== "edit" ? " ro" : "")} ref={rootRef}>
          <style>{threadCss}</style>
          {screen === "gallery" ? (
            <Suspense fallback={<Splash />}>
            <Gallery
              parent={parent}
              canBack
              onBack={() => setScreen("editor")}
              onUse={pickTemplate}
              onStart={start}
              onTeam={() => {
                postToHost("UI_Templates", {});
                toast(`Your team's saved templates come from ${hostName}`, { icon: "users-round" });
              }}
              team={session.demo ? undefined : team}
              hostName={hostName}
              onTeamUse={pickTeam}
              onTeamRetry={loadTeam}
            />
            </Suspense>
          ) : null}
          <div className={screen === "gallery" ? "hidden" : "wsp" + (side === "history" && canHistory ? " vh-open" : "") + (previewing && side === "history" ? " vh-previewing" : "")}>
            {hostChrome ? null : <TopBar
              temporaryTitle={words.pill}
              meta={meta}
              parent={parent}
              hostName={hostName}
              role={effectiveRole}
              save={shownSave}
              peers={peers}
              following={following}
              openThreads={openThreads}
              commentsOpen={side === "comments"}
              wide={wide}
              canExport={session.perms.export !== false}
              canDownload={session.perms.download !== false}
              temporary={temporary}
              onFollow={follow}
              onComments={featureOn("comments") ? () => (side === "comments" ? closeSide() : setSide("comments")) : undefined}
              onImportInto={impFormats.length ? openImport : undefined}
              onWide={() =>
                setWide((w) => {
                  try {
                    localStorage.setItem("oc:wide", w ? "0" : "1");
                  } catch {
                    /* private mode */
                  }
                  return !w;
                })
              }
              onExport={doExport}
              onHistory={canHistory ? () => setSide("history") : undefined}
              onNameVersion={canNameVersion ? () => (setSide("history"), setNameReq((n) => n + 1)) : undefined}
              onRetry={() => collab.sendControl({ t: "save" })}
              onShortcuts={() => setHelp(true)}
              onAssistant={ai.on ? openAssistant : undefined}
              onFind={editor ? () => openFind(false) : undefined}
              onSearchAll={searchOn ? () => setSearchAll(true) : undefined}
              onLinkedFrom={linksOn ? () => setSide((s) => (s === "links" ? null : "links")) : undefined}
              onGraph={linksOn ? () => setSide((s) => (s === "graph" ? null : "graph")) : undefined}
              graphOpen={side === "graph"}
              onAutomations={autoOn ? () => (side === "automations" ? closeSide() : setSide("automations")) : undefined}
              automationsHere={ruleCount}
              offline={
                offlineOn
                  ? {
                      onToggle: (on) => void offlineUi().then((m) => m.toggleKeep(on)),
                      onList: () => void offlineUi().then((m) => m.openList()),
                      onTryNow: () => void import("./offline/controller").then((m) => m.controller()?.kick()),
                    }
                  : undefined
              }
            />}
            {banners}
            {offlineOn ? (
              <Suspense fallback={null}>
                <OfflineRoot
                  hostName={hostName}
                  me={session.user.name}
                  title={meta.title || session.file.name}
                  doc={doc}
                  canDownload={session.perms.download !== false}
                  onHistory={canHistory ? () => setSide("history") : undefined}
                  nameOfClient={(client) => (awareness.getStates().get(client) as { user?: { name?: string } } | undefined)?.user?.name?.split(" ")[0] ?? null}
                  onBack={() => postToHost("UI_Close", { reason: "offline-revoked" })}
                />
              </Suspense>
            ) : null}
            <div className="body">
              <div className="scroll" ref={scrollRef} onMouseDown={(e) => { if (focusEndOnClickBelow(editor, e.target, e.clientY)) e.preventDefault(); }}>
                <div className={"doc" + (wide && !compact ? " wide" : "")}>
                  {ov.locked || ov.revoked ? (
                    <Suspense fallback={null}>
                      <LockedCanvas title={ov.revoked ? "" : meta.title || session.file.name} />
                    </Suspense>
                  ) : null}
                  {/* 5c/5b: the title only. The editor is not rendered at all, so nothing of the
                      canvas stays in the page (OFF-08). */}
                  {ov.locked || ov.revoked ? null : (
                  <div>
                  <DocHeader
                    doc={doc}
                    meta={meta}
                    editable={effectiveRole === "edit"}
                    hostName={hostName}
                    temporary={temporary}
                    lastEdit={lastEdit ?? (save.kind === "saved" ? save.at : null)}
                    lastEditBy={lastEditBy}
                    peopleHere={peers.length}
                    onEnter={() => editor?.commands.focus("start")}
                  />
                  <CanvasEditor
                    doc={doc}
                    awareness={awareness}
                    role={effectiveRole}
                    me={me}
                    users={allUsers}
                    searchUsers={searchUsers}
                    onReady={setEditor}
                    onComment={onComment}
                    emptyState={emptyActions}
                  />
                  </div>
                  )}
                </div>
              </div>
              {dbMenu ? (
                <Suspense fallback={null}>
                  <AutomateMenu anchor={dbMenu.anchor} dbId={dbMenu.dbId} rules={rulesOf(dbMenu.dbId)} onClose={() => setDbMenu(null)} onOpen={() => (setDbMenu(null), setSide("automations"))} />
                </Suspense>
              ) : null}
              {searchAll && searchOn ? (
                <Suspense fallback={null}>
                  <SearchAll
                    ticket={session.ticket}
                    hostName={hostName}
                    fileId={session.file.id}
                    compact={compact}
                    onClose={() => setSearchAll(false)}
                    onOpenHere={(blockId, q) => {
                      if (blockId) scrollToBlock(blockId);
                      setFind((f) => ({ initial: q, replace: false, tick: (f?.tick ?? 0) + 1 }));
                    }}
                    onOpenFile={(h, newTab) => postToHost("UI_OpenFile", { fileId: h.fileId, ...(h.blockId ? { blockId: h.blockId } : {}), newTab })}
                  />
                </Suspense>
              ) : null}
              {linksOn && editor ? (
                <Suspense fallback={null}>
                  <LinksRoot
                    editor={editor}
                    ticket={session.ticket}
                    fileId={session.file.id}
                    title={meta.title || session.file.name}
                    aliases={meta.aliases ?? []}
                    canEdit={effectiveRole === "edit"}
                    compact={compact}
                    mentions={!!session.links?.mentions}
                    patterns={session.links?.urlPatterns ?? []}
                    side={side === "links"}
                    setSide={(open) => setSide(open ? "links" : (s) => (s === "links" ? null : s))}
                    toast={(m, o) => toast(m, o ?? {})}
                    open={(fileId, blockId, newTab) =>
                      fileId === session.file.id && blockId ? scrollToBlock(blockId) : postToHost("UI_OpenFile", { fileId, ...(blockId ? { blockId } : {}), newTab })
                    }
                    scrollToBlock={scrollToBlock}
                    onComments={session.perms.comment !== false || threads.length ? () => setSide("comments") : undefined}
                  />
                </Suspense>
              ) : null}
              {side === "graph" && linksOn ? (
                <Suspense fallback={<aside className="side" aria-label="Local graph" aria-busy="true" />}>
                  <GraphRoot
                    mode="local"
                    ticket={session.ticket}
                    fileId={session.file.id}
                    title={meta.title || session.file.name}
                    userId={session.user.id}
                    hostName={hostName}
                    compact={compact}
                    open={openFromGraph}
                    onClose={() => setSide(null)}
                    onFull={() => setGraphFull(true)}
                    onLinkedFrom={() => setSide("links")}
                    toast={(m) => toast(m, {})}
                  />
                </Suspense>
              ) : null}
              {graphFull ? (
                <Suspense fallback={null}>
                  <GraphRoot
                    mode="full"
                    ticket={session.ticket}
                    fileId={session.file.id}
                    title={meta.title || session.file.name}
                    userId={session.user.id}
                    hostName={hostName}
                    compact={compact}
                    open={openFromGraph}
                    onClose={() => setGraphFull(false)}
                    onLinkedFrom={linksOn ? () => setSide("links") : undefined}
                    toast={(m) => toast(m, {})}
                  />
                </Suspense>
              ) : null}
              {find && editor ? (
                <Suspense fallback={null}>
                  <FindBar
                    editor={editor}
                    doc={doc}
                    canReplace={effectiveRole === "edit"}
                    compact={compact}
                    initial={find.initial}
                    replace={find.replace}
                    focusTick={find.tick}
                    scrollEl={scrollRef.current}
                    toast={(m, o) => toast(m, o ?? {})}
                    onClose={() => setFind(null)}
                  />
                </Suspense>
              ) : null}
              {side === "automations" && autoOn ? (
                <Suspense fallback={<aside className="side" aria-label="Automations" aria-busy="true" />}>
                  <AutomationPanel
                    start={autoStart}
                    onStarted={() => setAutoStart(null)}
                    doc={doc}
                    ticket={session.ticket}
                    info={{
                      enabled: true,
                      canEdit: !!session.automation?.canEdit && effectiveRole === "edit",
                      history: !!session.automation?.history,
                      limits: session.automation!.limits!,
                    }}
                    me={{ id: me.id, name: me.name }}
                    hostName={hostName}
                    compact={compact}
                    person={(id) => people.get(id)?.name ?? id}
                    onClose={() => setSide(null)}
                  />
                </Suspense>
              ) : null}
              {side === "comments" ? (
                <Suspense fallback={<aside className="side" aria-label="Comments" aria-busy="true" />}>
                  <CommentsPanel doc={doc} threads={threads} active={active} role={effectiveRole} me={me} users={allUsers} onActivate={setActive} onJump={jump} onClose={closeSide} onLinkedFrom={linksOn ? () => setSide("links") : undefined} />
                </Suspense>
              ) : null}
              {side === "history" && canHistory ? (
                <Suspense fallback={<aside className="side" aria-label="Version history" aria-busy="true" />}>
                  <HistoryRoot
                    session={session}
                    bridge={bridgeValue}
                    liveDoc={doc}
                    me={me}
                    peers={peers}
                    person={(id) => people.get(id)}
                    compact={compact}
                    role={effectiveRole}
                    temporary={temporary}
                    words={words}
                    tick={historyTick}
                    known={save.kind === "saved" ? save.version ?? null : null}
                    nameReq={nameReq}
                    onClose={() => setSide(null)}
                    onPreview={setPreviewing}
                    onDownload={() => doExport(session.perms.download !== false ? "ocanvas" : "pdf")}
                  />
                </Suspense>
              ) : null}
            </div>
          </div>
          {ai.on && editor ? (
            <Suspense fallback={null}>
              <AssistantRoot editor={editor} collab={collab} demo={!!session.demo} me={me} people={() => people.pickable()} role={effectiveRole} compact={compact} hostName={hostName} />
            </Suspense>
          ) : null}
          <Toasts />
          <Suspense fallback={null}>
            <PersonCards root={root} people={people} />
          </Suspense>

          <Suspense fallback={null}>
          {csv ? (
            <CsvImportDialog
              open
              env={env}
              onClose={() => setCsv(null)}
              onImport={(text) => {
                const cb = csv;
                setCsv(null);
                cb(text);
              }}
            />
          ) : null}
          {help ? <Shortcuts onClose={() => setHelp(false)} /> : null}
          {urlAsk ? <UrlPrompt kind={urlAsk.kind} onClose={() => setUrlAsk(null)} onUrl={urlAsk.cb} /> : null}
          {importInto && editor ? (
            <ImportInto editor={editor} doc={doc} ticket={session.demo ? null : session.ticket} formats={impFormats} demo={!!session.demo} boardId={importBoard} onClose={() => (setImportInto(false), setImportBoard(null))} />
          ) : null}
          {importing ? (
            <ImportDialog
              onClose={() => setImporting(false)}
              onImport={doImport}
              onPasteCsv={() =>
                setCsv(() => (text: string) => doImport({ kind: "csv", text, name: "Imported data" }))
              }
            />
          ) : null}
          </Suspense>
          <Suspense fallback={null}>
            {confirmTpl ? (
              <ReplaceConfirm
                team={confirmTeam}
                onCancel={() => (setConfirmTpl(null), setConfirmTeam(false))}
                onReplace={() => {
                  const f = confirmTpl;
                  setConfirmTpl(null);
                  setConfirmTeam(false);
                  f();
                }}
              />
            ) : null}
            {conflict?.open && !closed ? <ConflictModal policy={conflict.policy} url={conflict.url} hostName={hostName} copyName={copyName} onKeep={() => setConflict({ ...conflict, open: false })} onOpenCopy={openCopy} /> : null}
            {closed !== null ? <ClosedModal closed={closed} temporary={temporary} words={words} hostName={hostName} /> : null}
          </Suspense>
        </div>
      </BridgeCtx.Provider>
    </ShellCtx.Provider>
  );
}
