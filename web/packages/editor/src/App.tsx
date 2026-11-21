import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type { BlockEnv, OcUser, Role } from "@opencanvas/ui";
import { Ic, loadExtraIcons } from "./icons";
import { CanvasEditor } from "./editor/CanvasEditor";
import { loadDatabase } from "./editor/blockdata";
import type { TB } from "./editor/content";
import type { EmptyAction } from "./editor/CanvasEditor";
import { resolveAsset, setAssetTicket } from "./lib/assets";
import { BridgeCtx, setBridge, type Bridge, type Uploaded } from "./lib/bridge";
import { deleteThread, useThreads } from "./lib/comments";
import type { Demo } from "./lib/demo";
import type { ExportFormat } from "./lib/exports";
import { onHost, postToHost } from "./lib/host";
import { META_ORIGIN, setMeta, useLastEdit, useMeta } from "./lib/meta";
import { isMac } from "./lib/keys";
import { usePeers, type Peer } from "./lib/presence";
import { connectCollab, fetchSession, readLaunch, SessionError, type Collab, type Session } from "./lib/session";
import { toast } from "./lib/store";
import { DocHeader } from "./components/DocHeader";
import type { ImportResult } from "./components/Dialogs";
import { Modal, ModalHead, ShellCtx, Toasts } from "./components/overlay";
import { TopBar, type SaveState } from "./components/TopBar";
import type { Template } from "./templates";

// Everything below is off the first paint (docs/02 §7 bundle budget): it loads
// when first shown.
const Gallery = lazy(() => import("./components/Gallery").then((m) => ({ default: m.Gallery })));
const CommentsPanel = lazy(() => import("./components/CommentsPanel").then((m) => ({ default: m.CommentsPanel })));
const ImportDialog = lazy(() => import("./components/Dialogs").then((m) => ({ default: m.ImportDialog })));
const UrlPrompt = lazy(() => import("./components/Dialogs").then((m) => ({ default: m.UrlPrompt })));
const CsvImportDialog = lazy(() => loadDatabase().then((m) => ({ default: m.CsvImportDialog })));
const Shortcuts = lazy(() => import("./components/Shortcuts").then((m) => ({ default: m.Shortcuts })));

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

type Boot =
  | { phase: "loading" }
  | { phase: "error"; title: string; message: string; retry?: boolean }
  | { phase: "ready"; session: Session; collab: Collab; demo: Demo | null };

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
        setBoot({ phase: "ready", session: m.demoSession(role), collab: d.collab, demo: d });
        return;
      }
      if (!ticket) {
        setBoot({ phase: "error", title: "Open this canvas from your app", message: "This page needs a launch link from the app that stores the canvas." });
        return;
      }
      try {
        const s = await fetchSession(ticket);
        if (cancelled) return;
        setAssetTicket(s.ticket);
        collab = connectCollab(s);
        await collab.synced;
        if (cancelled) return;
        setBoot({ phase: "ready", session: s, collab, demo: null });
      } catch (e) {
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

  if (boot.phase === "loading") return <Splash />;
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
  const [roleChanged, setRoleChanged] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: null });
  const [conn, setConn] = useState<"connected" | "reconnecting" | "offline">("connected");
  const [conflict, setConflict] = useState<{ policy: "copy" | "reload" | null; fileId?: string; url?: string; open: boolean } | null>(null);
  const [closed, setClosed] = useState<{ kind: "revoked" | "host" | "other"; reason: string } | null>(null);
  const reloading = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [screen, setScreen] = useState<"editor" | "gallery">("editor");
  const [side, setSide] = useState<"comments" | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem("oc:wide") === "1";
    } catch {
      return false;
    }
  });
  const [following, setFollowing] = useState<string | null>(null);
  const [users, setUsers] = useState<OcUser[]>([]);
  const [lastEditBy, setLastEditBy] = useState<string | null>(null);
  const [csv, setCsv] = useState<((csv: string) => void) | null>(null);
  const [urlAsk, setUrlAsk] = useState<{ kind: "bookmark" | "embed"; cb: (u: string) => void } | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmTpl, setConfirmTpl] = useState<(() => void) | null>(null);
  const [help, setHelp] = useState(false);
  const pendingThread = useRef<string | null>(null);
  const modified = useRef(false);

  const effectiveRole: Role = forcedReadOnly || conflict || closed ? "view" : role;
  const meta = useMeta(doc);
  const lastEdit = useLastEdit(doc);
  const peers = usePeers(awareness);
  const threads = useThreads(doc);
  const openThreads = threads.filter((t) => !t.resolved).length;

  const me: OcUser = useMemo(() => ({ id: session.user.id, name: session.user.name, color: session.user.color, avatar: session.user.avatar ?? undefined }), [session.user]);

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
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------- people (mentions, assignees) ----------
  useEffect(() => {
    if (demo) {
      setUsers(Object.values(demo.users).map(({ id, name, color }) => ({ id, name, color })));
      return;
    }
    fetch(`/v1/users?ticket=${encodeURIComponent(session.ticket)}&q=`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { id: string; name: string; avatar?: string; color?: string }[]) =>
        setUsers(list.map((u, i) => ({ id: u.id, name: u.name, avatar: u.avatar, color: u.color ?? ["#2a5ad7", "#7a45f0", "#e5602a", "#0e9a78", "#d63f78"][i % 5] }))),
      )
      .catch(() => undefined);
  }, [session, demo]);

  const allUsers = useMemo(() => {
    const m = new Map<string, OcUser>();
    [me, ...users, ...peers.map((p) => ({ id: p.id, name: p.name, color: p.color }))].forEach((u) => m.set(u.id, { ...m.get(u.id), ...u }));
    return [...m.values()];
  }, [me, users, peers]);

  const searchUsers = useCallback(
    async (q: string): Promise<OcUser[]> => {
      const local = allUsers.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));
      if (session.demo || !q) return local;
      try {
        const r = await fetch(`/v1/users?ticket=${encodeURIComponent(session.ticket)}&q=${encodeURIComponent(q)}`);
        if (!r.ok) return local;
        const list = (await r.json()) as { id: string; name: string; avatar?: string }[];
        const m = new Map(local.map((u) => [u.id, u]));
        list.forEach((u) => m.set(u.id, m.get(u.id) ?? { id: u.id, name: u.name, avatar: u.avatar, color: "#6b7280" }));
        return [...m.values()];
      } catch {
        return local;
      }
    },
    [allUsers, session],
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
        setClosed((prev) => prev ?? { kind: e.code === 1008 ? "revoked" : "host", reason: e.reason });
      }),
      collab.onConn((s) => {
        if (s === "connected") setConn("connected");
        else if (s === "offline") setConn("offline");
        else setConn("reconnecting");
      }),
      collab.onDenied(() => {
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
    postToHost("Presence_Changed", { users: peers.map((p) => ({ id: p.id, name: p.name, color: p.color, role: p.role })) });
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
      onHost("Action_SetReadOnly", (v) => setForcedReadOnly(!!v.readOnly)),
      onHost("Action_Commit", (v) => collab.sendControl({ t: "save", message: v.message ?? null })),
      onHost("Action_Export", (v) => doExport(String(v.format ?? "md"))),
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
    if (session.isNew && role === "edit" && editor.isEmpty) setScreen("gallery");
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
    let off = false;
    loadDatabase()
      .then((m) => !off && um.trackedOrigins.add(m.DB_ORIGIN))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [editor, doc]);

  // ---------- deep links to a block: `#...&block=b_...` or the host's Action_ScrollToBlock ----------
  const scrollToBlock = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    if (!el) return toast("That block isn't in this canvas any more", { icon: "link" });
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1800);
  }, []);
  useEffect(() => {
    if (!editor) return;
    const id = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("block");
    const t = id ? window.setTimeout(() => scrollToBlock(id), 600) : undefined;
    const off = onHost("Action_ScrollToBlock", (v) => typeof v.blockId === "string" && scrollToBlock(v.blockId));
    return () => {
      window.clearTimeout(t);
      off();
    };
  }, [editor, scrollToBlock]);

  // ---------- keyboard shortcuts help: `?` outside text, Mod-Shift-/ anywhere ----------
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inText = !!t?.closest?.("input,textarea,select,[contenteditable=true]");
      const mod = isMac ? e.metaKey : e.ctrlKey;
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
  const env: BlockEnv = useMemo(
    () => ({ role: effectiveRole, me, users: allUsers, compact, toast: (m, action) => toast(m, { action }), upload: (f: File) => upload(f), resolveAsset }),
    [effectiveRole, me, allUsers, compact, upload],
  );

  const openThread = useCallback((id: string) => {
    setSide("comments");
    setActive(id);
  }, []);

  const bridgeValue: Bridge = useMemo(
    () => ({
      doc,
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
    const el = scrollRef.current?.querySelector(`.cmt[data-thread="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (compact) setSide(null);
  };
  const threadCss = useMemo(
    () =>
      threads
        .filter((t) => t.resolved)
        .map((t) => `.ProseMirror .cmt[data-thread="${CSS.escape(t.id)}"]{background:none;border-bottom:0;cursor:text}`)
        .join("") + (active && side ? `.ProseMirror .cmt[data-thread="${CSS.escape(active)}"]{background:color-mix(in srgb,var(--amber-fg) 30%,transparent)}` : ""),
    [threads, active, side],
  );

  // ---------- follow mode ----------
  const follow = useCallback(
    (p: Peer) => {
      if (following === p.id) {
        setFollowing(null);
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
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, meta.title, compact],
  );

  // ---------- derived ----------
  const shownSave: SaveState =
    conflict || closed ? { kind: "paused" } : conn === "offline" ? { kind: "offline" } : conn === "reconnecting" ? { kind: "reconnecting" } : save;
  const parent = session.demo ? "Engineering" : hostName;

  const banners: React.ReactNode[] = [];
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
  if (effectiveRole === "view" && !roleChanged && !conflict && !closed)
    banners.push(
      <div key="view" className="banner info">
        <Ic name="eye" />
        <span>{forcedReadOnly ? "This canvas is read-only right now." : `You can view this canvas. Ask in ${hostName} for edit access.`}</span>
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
  if (conn === "offline")
    banners.push(
      <div key="offline" className="banner warn">
        <Ic name="wifi-off" />
        <span>You're offline. Keep working. Your changes sync when you reconnect.</span>
      </div>,
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
            />
            </Suspense>
          ) : null}
          <div className={screen === "gallery" ? "hidden" : "wsp"}>
            <TopBar
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
              onGallery={() => setScreen("gallery")}
              onFollow={follow}
              onComments={() => (side ? closeSide() : setSide("comments"))}
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
              onHistory={() => {
                postToHost("UI_FileVersions", {});
                toast(`Version history lives in ${hostName}`, { icon: "history" });
              }}
              onRetry={() => collab.sendControl({ t: "save" })}
              onShortcuts={() => setHelp(true)}
            />
            {banners}
            <div className="body">
              <div className="scroll" ref={scrollRef}>
                <div className={"doc" + (wide && !compact ? " wide" : "")}>
                  <DocHeader
                    doc={doc}
                    meta={meta}
                    editable={effectiveRole === "edit"}
                    hostName={hostName}
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
              </div>
              {side === "comments" ? (
                <Suspense fallback={<aside className="side" aria-label="Comments" aria-busy="true" />}>
                  <CommentsPanel doc={doc} threads={threads} active={active} role={effectiveRole} me={me} users={allUsers} onActivate={setActive} onJump={jump} onClose={closeSide} />
                </Suspense>
              ) : null}
            </div>
          </div>
          <Toasts />

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
          {confirmTpl ? (
            <Modal onClose={() => setConfirmTpl(null)} label="Replace canvas">
              <ModalHead
                title="Replace this canvas?"
                sub={`Everyone here sees the change right away. You can undo it with ${isMac ? "⌘Z" : "Ctrl+Z"}.`}
                icon="layout-template"
                tone="amber"
              />
              <div className="mft" style={{ paddingTop: 18 }}>
                <button className="btn ghost" data-autofocus onClick={() => setConfirmTpl(null)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    const f = confirmTpl;
                    setConfirmTpl(null);
                    f();
                  }}
                >
                  Replace content
                </button>
              </div>
            </Modal>
          ) : null}
          {conflict?.open && !closed ? (
            <Modal onClose={() => setConflict({ ...conflict, open: false })} label="Canvas changed">
              <ModalHead title={`This canvas changed in ${hostName}`} sub="Someone replaced the file from outside this session." icon="triangle-alert" tone="amber" />
              <div className="mbd">
                <div className="callout" style={{ margin: 0 }} data-tone="green">
                  <span className="cic tone-green">
                    <Ic name="copy" />
                  </span>
                  <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                    {conflict.policy === "copy" ? (
                      <>
                        Your edits are safe. They were saved as <b>“{copyName}”</b> in {hostName}. This canvas is read-only now.
                      </>
                    ) : (
                      <>Your edits up to now are kept in this session. Reload to continue from the version in {hostName}.</>
                    )}
                  </div>
                </div>
              </div>
              <div className="mft">
                <button className="btn ghost" onClick={() => setConflict({ ...conflict, open: false })}>
                  Keep reading
                </button>
                {conflict.policy === "copy" && conflict.url ? (
                  <button className="btn primary" onClick={openCopy}>
                    Open the copy
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => window.location.reload()}>
                    Reload
                  </button>
                )}
              </div>
            </Modal>
          ) : null}
          {closed !== null ? (
            <Modal onClose={() => undefined} dismissable={false} label="Canvas closed">
              {closed.kind === "revoked" ? (
                <ModalHead title="Your access to this canvas changed" sub={`${hostName} no longer lets you open this canvas. Ask the owner if you need it.`} icon="lock" tone="gray" />
              ) : (
                <ModalHead
                  title={`${hostName} closed this canvas`}
                  sub={(closed.reason && closed.kind === "other" ? closed.reason.replace(/^./, (c) => c.toUpperCase()) + ". " : "") + "Everything up to now was saved."}
                  icon="lock"
                  tone="gray"
                />
              )}
              <div className="mft" style={{ paddingTop: 18 }}>
                <button className="btn primary" onClick={() => postToHost("UI_Close", {})}>
                  Back to {hostName}
                </button>
              </div>
            </Modal>
          ) : null}
        </div>
      </BridgeCtx.Provider>
    </ShellCtx.Provider>
  );
}
