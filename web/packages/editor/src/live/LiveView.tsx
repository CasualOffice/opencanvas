// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The live block chrome and the reference card (LIVE-03/04/07), to the approved prototype
// docs/prototypes/v03-approved/live-blocks.html: header (2a), presence with "from" (2b), the
// first-edit hint (2b), the options menu (2c), who can see this (2d), view only (2e), convert to
// a copy (2f), reference card states (3a-3c), failure states (5a-5g) and the phone sheet (6a-6d).
// Lazy: nothing here is in the first bundle.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NodeViewWrapper, type Editor, type ReactNodeViewProps } from "@tiptap/react";
import { ExternalLink, EyeOff, Folder, Link2, Link2Off, ListChecks, OctagonAlert, Radio, RefreshCw, Trash2, UserRoundX, Users, Shapes, Image as ImageIcon, MapPin, Ellipsis } from "lucide-react";
import * as Y from "yjs";
import type { Role } from "@opencanvas/ui";
import { ICONS, Ic } from "../icons";
import { BridgeCtx, useBridge, type Bridge } from "../lib/bridge";
import { Avatar, Modal, ModalHead, Popover, useShell } from "../components/overlay";
import { postToHost, onHost } from "../lib/host";
import { toast } from "../lib/store";
import { usePeers } from "../lib/presence";
import { CanvasEditor } from "../editor/CanvasEditor";
import { audience, lastProjection, projection, type Audience, type Projection } from "./api";
import { retryRoom, useRoomEntry, type LiveRoom } from "./conn";
import { Projected, SnapshotText } from "./render";
import { copyBlockLink, liveCfg, nestedEditors } from "./state";
import "./live.css";

Object.assign(ICONS, {
  radio: Radio, "external-link": ExternalLink, "refresh-cw": RefreshCw, "link-2-off": Link2Off, "octagon-alert": OctagonAlert, "user-round-x": UserRoundX,
  folder: Folder, "list-checks": ListChecks, users: Users, "trash-2": Trash2, shapes: Shapes, image: ImageIcon, "eye-off": EyeOff, "map-pin": MapPin, ellipsis: Ellipsis, "link-2": Link2,
});

const hm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function ago(ms: number | null, now: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "Updated just now";
  const m = Math.round(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `Updated ${h} h ago` : `Updated ${new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function useRoom(fileId: string, el: React.RefObject<HTMLElement | null>) {
  const [h] = useState(() => useRoomEntry(fileId));
  const [, force] = useState(0);
  useEffect(() => {
    const off = h.sub(() => force((n) => n + 1));
    const io = new IntersectionObserver((es) => h.visible(es.some((e) => e.isIntersecting)), { rootMargin: "200px" });
    if (el.current) io.observe(el.current);
    return () => {
      off();
      io.disconnect();
      h.release();
    };
  }, [h, el]);
  return h.room;
}

/** Re-renders every 30 s (relative times). */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

const hostName = (b: Bridge) => b.session?.host?.name || "your app";

function openSource(fileId: string, blockId?: string, reason?: "request" | "share") {
  postToHost("UI_LiveBlockOpen", { fileId, ...(blockId ? { blockId } : {}), ...(reason ? { reason } : {}) });
}

// ---------- the nested editor of a connected live block ----------

function Nested({ room, editable, onEditor, onLocalEdit }: { room: LiveRoom; editable: boolean; onEditor(e: Editor | null): void; onLocalEdit(): void }) {
  const parent = useBridge();
  const collab = room.collab!;
  const ctx: Bridge = useMemo(
    () => ({ ...parent, doc: collab.doc, awareness: collab.awareness, session: room.session ?? parent.session, env: { ...parent.env, role: editable ? "edit" : "view", undoManager: undefined } }),
    [parent, collab, room.session, editable],
  );
  const ready = useCallback(
    (e: Editor | null) => {
      if (e) {
        nestedEditors.add(e);
        e.on("transaction", ({ transaction }) => {
          if (transaction.docChanged && !transaction.getMeta("y-sync$")) onLocalEdit();
        });
      }
      onEditor(e);
    },
    [onEditor, onLocalEdit],
  );
  return (
    <BridgeCtx.Provider value={ctx}>
      <CanvasEditor nested doc={collab.doc} awareness={collab.awareness} role={editable ? "edit" : "view"} me={parent.env.me} users={[]} searchUsers={async () => []} onReady={ready} onComment={() => undefined} />
    </BridgeCtx.Provider>
  );
}

function People({ room }: { room: LiveRoom }) {
  const peers = usePeers(room.collab!.awareness).filter((p) => !p.me && !p.agent);
  if (!peers.length) return null;
  const shown = peers.slice(0, 3);
  return (
    <span className="lb-ppl" aria-label={`${peers.length} ${peers.length === 1 ? "person" : "people"} here: ${peers.map((p) => p.name).join(", ")}`} role="img">
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} color={p.color} avatar={p.avatar} cls="xs" />
      ))}
      {peers.length > 3 ? <span className="lb-more">+{peers.length - 3}</span> : null}
    </span>
  );
}

// ---------- the first-edit hint (2b) ----------

const HINT_KEY = "oc:livehint:";
function hintSeen(b: Bridge): boolean {
  try {
    return localStorage.getItem(HINT_KEY + (b.session?.host?.id ?? "") + ":" + (b.session?.user?.id ?? "")) === "1";
  } catch {
    return true;
  }
}
function markHint(b: Bridge) {
  try {
    localStorage.setItem(HINT_KEY + (b.session?.host?.id ?? "") + ":" + (b.session?.user?.id ?? ""), "1");
  } catch {
    /* storage blocked: the hint may show again */
  }
}

/** Asks the host's usage index (`UI_LiveBlockUsage` → `Action_LiveBlockUsage {fileId, places}`). */
function askUsage(fileId: string, ms = 1500): Promise<string[] | null> {
  return new Promise((resolve) => {
    const off = onHost("Action_LiveBlockUsage", (v) => {
      if (v.fileId !== fileId) return;
      off();
      window.clearTimeout(t);
      resolve(Array.isArray(v.places) ? v.places.filter((x): x is string => typeof x === "string").slice(0, 20) : null);
    });
    const t = window.setTimeout(() => {
      off();
      resolve(null);
    }, ms);
    postToHost("UI_LiveBlockUsage", { fileId });
  });
}

function hintText(places: string[] | null, here: string): string {
  if (!places || places.length < 2) return "Edits here change it everywhere it’s used.";
  const others = places.filter((p) => p !== here);
  const list = others.length > 2 ? `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}` : others.join(" and ");
  return `Edits here change it in ${places.length} places: this canvas, ${list}.`;
}

// ---------- the options menu (2c) and the phone sheet (6b) ----------

interface MenuProps {
  anchor: HTMLElement;
  title: string;
  fileId: string;
  role: Role | null;
  canEdit: boolean;
  canCopy: boolean;
  compact: boolean;
  onClose(): void;
  onWho(): void;
  onCopy(): void;
  onRemove(): void;
  onRefresh(): void;
}

function LiveMenu(p: MenuProps) {
  const b = useBridge();
  const host = hostName(b);
  const run = (f: () => void) => () => {
    p.onClose();
    f();
  };
  return (
    <Popover anchor={p.anchor} onClose={p.onClose} title={p.compact ? p.title : "Live block options"} alignRight minWidth={240} className="lb-menu">
      {p.compact ? (
        <p className="lb-sheet-sub">
          Live block from {host}.{p.role ? (p.role === "edit" ? " You can edit it." : " You can view it.") : ""}
        </p>
      ) : null}
      <button className="mi" onClick={run(() => openSource(p.fileId))}>
        <Ic name="external-link" />
        Open source in {host}
      </button>
      <button
        className="mi"
        onClick={run(() => {
          void copyBlockLink({ fileId: p.fileId, live: true }, p.title || p.fileId).then(() => toast("Link copied. Paste it in a canvas to show this live block there.", { icon: "link" }));
          postToHost("UI_LiveBlockLink", { fileId: p.fileId });
        })}
      >
        <Ic name="link" />
        Copy link
      </button>
      {!p.compact ? (
        <button className="mi" onClick={run(() => postToHost("UI_LiveBlockUsage", { fileId: p.fileId, show: true }))}>
          <Ic name="map-pin" />
          Where it’s used
        </button>
      ) : null}
      <button className="mi" onClick={run(p.onWho)}>
        <Ic name="users" />
        Who can see this
      </button>
      {!p.compact ? (
        <button className="mi" onClick={run(p.onRefresh)}>
          <Ic name="refresh-cw" />
          Refresh
        </button>
      ) : null}
      {p.canEdit ? (
        <>
          <div className="msep" />
          {p.canCopy ? (
            <button className="mi" onClick={run(p.onCopy)}>
              <Ic name="link-2-off" />
              Convert to a copy…
            </button>
          ) : null}
          <button className="mi danger" onClick={run(p.onRemove)}>
            <Ic name="trash-2" />
            Remove from this canvas
          </button>
        </>
      ) : null}
    </Popover>
  );
}

function WhoCanSee({ anchor, fileId, title, onClose }: { anchor: HTMLElement; fileId: string; title: string; onClose(): void }) {
  const b = useBridge();
  const host = hostName(b);
  const [a, setA] = useState<Audience | null | "error">(null);
  useEffect(() => {
    let off = false;
    audience(fileId).then(
      (r) => !off && setA(r),
      () => !off && setA("error"),
    );
    return () => {
      off = true;
    };
  }, [fileId]);
  const snapshot = liveCfg.get().snapshot;
  const sees = snapshot === "content" ? "They see the last saved copy." : snapshot === "title" ? "They see its title only." : "They see that something is hidden.";
  return (
    <Popover anchor={anchor} onClose={onClose} title="Who can see this" alignRight minWidth={300} kind="dialog" className="lb-pop">
      <div className="lb-pop-b">
        <h3>Who can see this</h3>
        <p>
          Access comes from <b>{title || "this live block"}</b> in {host}, not from this canvas.
        </p>
        {a === null ? (
          <p className="lb-acc" aria-busy="true">
            <Ic name="loader-circle" className="spin" />
            Checking…
          </p>
        ) : a === "error" ? null : (
          <>
            <p className="lb-acc">
              <Ic name={a.role === "edit" ? "circle-check" : "eye"} />
              {a.role === "edit" ? "You can edit it." : a.role === "none" ? "You can’t open it." : a.role === "comment" ? "You can comment on it." : "You can view it."}
            </p>
            {a.cannotOpen != null ? (
              <p className="lb-acc">
                <Ic name="user-round-x" />
                {a.cannotOpen === 0
                  ? "Everyone with access to this canvas can open it."
                  : `${a.cannotOpen} ${a.cannotOpen === 1 ? "person" : "people"} with access to this canvas can’t open it. ${sees}`}
              </p>
            ) : null}
          </>
        )}
        <button
          className="btn sm"
          onClick={() => {
            onClose();
            openSource(fileId, undefined, "share");
          }}
        >
          <Ic name="external-link" size={14} />
          Change access in {host}
        </button>
      </div>
    </Popover>
  );
}

function ConvertDialog({ title, places, onClose, onConvert }: { title: string; places: number | null; onClose(): void; onConvert(): void }) {
  const other = places != null && places > 1 ? ` The live block stays in the other ${places - 1} ${places - 1 === 1 ? "place" : "places"}.` : " The live block stays where else it is used.";
  return (
    <Modal onClose={onClose} label="Convert to a copy?">
      <ModalHead title="Convert to a copy?" icon="link-2-off" onClose={onClose} />
      <div className="mbd">
        <p>
          This canvas gets its own copy of <b>{title || "this live block"}</b>. Changes here won’t show in the live block, and changes there won’t show here.
          {other}
        </p>
      </div>
      <div className="mft">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" data-autofocus onClick={onConvert}>
          Convert to a copy
        </button>
      </div>
    </Modal>
  );
}

// ---------- copies (unlink, keep last copy) ----------

const strip = (n: unknown): unknown => {
  if (Array.isArray(n)) return n.map(strip);
  if (!n || typeof n !== "object") return n;
  const o = { ...(n as Record<string, unknown>) };
  if (o.attrs && typeof o.attrs === "object") {
    const a = { ...(o.attrs as Record<string, unknown>) };
    delete a.blockId;
    o.attrs = a;
  }
  if (o.content) o.content = strip(o.content);
  return o;
};

function usesData(content: unknown[]): boolean {
  const s = JSON.stringify(content);
  return s.includes('"dbId"') || s.includes('"boardId"');
}

/** Replaces the node at `pos` with `content` in one undoable step, copying the databases and
 *  boards it shows from the live room's document. */
function replaceWith(editor: Editor, pos: number, size: number, content: unknown[], from: Y.Doc | null, into: Y.Doc) {
  if (from) {
    const s = JSON.stringify(content);
    into.transact(() => {
      for (const root of ["databases", "boards"] as const) {
        const src = from.getMap(root);
        const dst = into.getMap(root);
        src.forEach((v, k) => {
          if (s.includes(JSON.stringify(k)) && !dst.has(k) && v instanceof Y.Map) dst.set(k, v.clone());
        });
      }
    });
  }
  const blocks = (strip(content) as unknown[]).length ? (strip(content) as object[]) : [{ type: "paragraph" }];
  editor.chain().focus().insertContentAt({ from: pos, to: pos + size }, blocks).run();
}

function snapshotBlocks(md: string): object[] {
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 400)
    .map((l) => {
      const task = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(l);
      if (task) return { type: "taskList", content: [{ type: "taskItem", attrs: { checked: task[1] !== " " }, content: [{ type: "paragraph", content: task[2] ? [{ type: "text", text: task[2] }] : [] }] }] };
      const h = /^(#{1,3})\s+(.*)$/.exec(l);
      if (h) return { type: "heading", attrs: { level: h[1].length }, content: [{ type: "text", text: h[2] }] };
      const t = l.replace(/^[-*>]\s+/, "");
      return { type: "paragraph", content: t ? [{ type: "text", text: t }] : [] };
    });
}

// ---------- the live block ----------

export function LiveBlockView(props: ReactNodeViewProps) {
  const { node, editor, getPos, selected } = props;
  const b = useBridge();
  const { compact } = useShell();
  const a = node.attrs as { fileId: string; title: string; snapshot?: { markdown?: string } | null; snapshotAt?: string; blockId?: string };
  const wrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const room = useRoom(a.fileId, wrap);
  const now = useNow();
  const [proj, setProj] = useState<Projection | null>(() => lastProjection(a.fileId) ?? null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [who, setWho] = useState<HTMLElement | null>(null);
  const [convert, setConvert] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [places, setPlaces] = useState<number | null>(null);
  const nested = useRef<Editor | null>(null);
  const hinted = useRef(false);
  const canEditCanvas = editor.isEditable;
  const pos = () => (typeof getPos === "function" ? getPos() : undefined);
  const st = room.state;
  const title = room.name && room.name !== a.fileId ? room.name : a.title || proj?.name || "";
  const host = hostName(b);
  const editable = st === "connected" && (room.role === "edit" || room.role === "comment") && room.role === "edit";

  // The projection while not connected (5a, 5b): fetched once, then whenever it reconnects.
  useEffect(() => {
    if (st === "connected" || st === "noaccess" || st === "gone" || st === "revoked") return;
    let off = false;
    projection(a.fileId).then(
      (r) => !off && setProj(r.p),
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [a.fileId, st]);

  // 5f: focus leaves the hidden text for the header.
  useEffect(() => {
    if (st === "revoked" && wrap.current?.contains(document.activeElement)) head.current?.focus();
  }, [st]);

  const onLocalEdit = useCallback(() => {
    if (hinted.current || hintSeen(b)) return;
    hinted.current = true;
    markHint(b);
    void askUsage(a.fileId).then((p) => {
      setPlaces(p?.length ?? null);
      setHint(hintText(p, b.session?.file?.name ?? ""));
      window.setTimeout(() => setHint(null), 10_000);
    });
  }, [a.fileId, b]);

  const remove = () => {
    const at = pos();
    if (at === undefined) return;
    editor.chain().focus().deleteRange({ from: at, to: at + node.nodeSize }).run();
    toast("Live block removed from this canvas", { icon: "trash-2", action: { label: "Undo", run: () => editor.commands.undo() } });
  };
  const copyContent = (): unknown[] | null => {
    if (st === "connected" && nested.current) return (nested.current.getJSON().content ?? []) as unknown[];
    if (proj && !usesData(proj.doc.content ?? [])) return (proj.doc.content ?? []) as unknown[];
    return null;
  };
  const doConvert = () => {
    setConvert(false);
    const at = pos();
    const content = copyContent();
    if (at === undefined || !content) return toast("Connect to the live block first, then try again.", { icon: "triangle-alert" });
    replaceWith(editor, at, node.nodeSize, content, st === "connected" ? room.collab!.doc : null, b.doc);
    toast("Converted to a copy", { icon: "link-2-off", action: { label: "Undo", run: () => editor.commands.undo() } });
  };
  const keepCopy = () => {
    const at = pos();
    if (at === undefined || !a.snapshot?.markdown) return;
    editor.chain().focus().insertContentAt({ from: at, to: at + node.nodeSize }, snapshotBlocks(a.snapshot.markdown)).run();
  };

  const openMenu = (el: HTMLElement) => setMenu(el);
  const headClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Phone (6a): tapping the header (not the content) opens the sheet.
    if (compact && !(e.target as HTMLElement).closest("button")) openMenu(e.currentTarget);
  };
  const snapshotPolicy = liveCfg.get().snapshot;

  // 5d: no access and no title: one neutral line, no header.
  if ((st === "noaccess" || st === "revoked") && !title && snapshotPolicy === "none")
    return (
      <NodeViewWrapper className={"lb noaccess-none" + (selected ? " sel" : "")} data-live-file={a.fileId} data-state={st} ref={wrap}>
        <div className="lb-na solo" contentEditable={false}>
          <Ic name="eye-off" size={18} />
          <div>
            <b>A live block you can’t open</b>
            Its title and content are hidden. Ask the person who shared this canvas.
          </div>
        </div>
      </NodeViewWrapper>
    );

  const failure = st === "noaccess" || st === "gone" || st === "revoked";
  const busy = st === "connecting" || st === "queued";
  const roView = st === "connected" && room.role !== "edit";
  return (
    <NodeViewWrapper
      className={"lb" + (selected ? " sel" : "") + (compact ? " c" : "") + (roView ? " view" : "")}
      data-live-file={a.fileId}
      data-state={st}
      ref={wrap}
      aria-busy={busy || undefined}
    >
      <div className="lb-h" contentEditable={false} ref={head} tabIndex={-1} onClick={headClick} aria-label={`Live block: ${title || "untitled"}`} role="group">
        <span className="lb-live">
          <Ic name="radio" size={12} />
          Live
        </span>
        <span className="lb-t">{title || "Live block"}</span>
        {!compact && !failure ? <span className="lb-src">from {host}</span> : null}
        {st === "connected" && room.role !== "edit" ? (
          <span className="lb-ro">
            <Ic name="eye" size={12} />
            View only
          </span>
        ) : null}
        {busy && st === "connecting" ? (
          <span className="lb-ro" role="status">
            <Ic name="loader-circle" size={12} className="spin" />
            Connecting
          </span>
        ) : null}
        <span className="lb-sp" />
        {st === "connected" && !compact ? <People room={room} /> : null}
        {!failure && !compact ? (
          <button className="ib" title={`Open source in ${host}`} aria-label={`Open source in ${host}`} onClick={() => openSource(a.fileId)}>
            <Ic name="external-link" size={15} />
          </button>
        ) : null}
        {!failure || canEditCanvas ? (
          <button className={"ib" + (menu ? " on" : "")} aria-label="Live block options" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => openMenu(e.currentTarget)}>
            <Ic name="ellipsis" size={16} />
          </button>
        ) : null}
      </div>
      {hint ? (
        <div className="lb-hint" contentEditable={false} role="status">
          <Ic name="info" size={14} />
          {hint}
        </div>
      ) : null}
      {st === "stale" ? (
        <div className="lb-st warn" contentEditable={false} role="status">
          <Ic name="cloud-off" size={15} />
          <span>
            <b>Not up to date.</b> Couldn’t reach the live block.{" "}
            {proj || room.syncedAt ? `This is the copy from ${hm(proj?.at ?? room.syncedAt ?? Date.now())}; editing is off until it reconnects.` : "Editing is off until it reconnects."}
          </span>
          <button className="lb-a" onClick={() => retryRoom(a.fileId)}>
            <Ic name="refresh-cw" size={13} />
            Retry
          </button>
        </div>
      ) : null}
      {st === "noaccess" ? (
        <div className="lb-na" contentEditable={false}>
          <Ic name="lock" size={18} />
          <div>
            <b>You don’t have access to this live block</b>
            It belongs to another file in {host}. Ask its owner, or request access there.
          </div>
          <button className="btn sm" onClick={() => openSource(a.fileId, undefined, "request")}>
            Request access
          </button>
        </div>
      ) : st === "gone" ? (
        <div className="lb-na" contentEditable={false}>
          <Ic name="octagon-alert" size={18} />
          <div>
            <b>This live block was deleted or moved</b>
            {host} can’t find its file any more. Nothing else in this canvas changed.
          </div>
          {canEditCanvas && snapshotPolicy === "content" && a.snapshot?.markdown ? (
            <button className="btn sm" onClick={keepCopy}>
              Keep last copy
            </button>
          ) : null}
          {canEditCanvas ? (
            <button className="btn sm" onClick={remove}>
              Remove
            </button>
          ) : null}
        </div>
      ) : st === "revoked" ? (
        <div className="lb-na" contentEditable={false} role="alert">
          <Ic name="user-round-x" size={18} />
          <div>
            <b>Your access was removed just now</b>
            Your last change before that was saved. The content is hidden from you from now on.
          </div>
        </div>
      ) : st === "connected" && room.collab ? (
        <div className="lb-b" data-live-body>
          <Nested room={room} editable={editable} onEditor={(e) => (nested.current = e)} onLocalEdit={onLocalEdit} />
        </div>
      ) : (
        <div className={"lb-b lv fade"} contentEditable={false} aria-busy={busy || undefined}>
          {proj ? <Projected doc={proj.doc} /> : a.snapshot?.markdown ? <SnapshotText markdown={a.snapshot.markdown} /> : <div className="lv-skel" aria-hidden="true"><i /><i /><i /></div>}
        </div>
      )}
      {menu ? (
        <LiveMenu
          anchor={menu}
          title={title}
          fileId={a.fileId}
          role={st === "connected" ? room.role : null}
          canEdit={canEditCanvas}
          canCopy={!failure && (st === "connected" || (!!proj && !usesData(proj.doc.content ?? [])))}
          compact={compact}
          onClose={() => setMenu(null)}
          onWho={() => setWho(head.current)}
          onCopy={() => setConvert(true)}
          onRemove={remove}
          onRefresh={() => retryRoom(a.fileId)}
        />
      ) : null}
      {who ? <WhoCanSee anchor={who} fileId={a.fileId} title={title} onClose={() => setWho(null)} /> : null}
      {convert ? <ConvertDialog title={title} places={places} onClose={() => setConvert(false)} onConvert={doConvert} /> : null}
      <span hidden data-now={now} />
    </NodeViewWrapper>
  );
}

// ---------- the reference card (3a-3c) ----------

const POLL_MS = 15_000;

function useTypingPause(editor: Editor): () => boolean {
  const last = useRef(0);
  useEffect(() => {
    const on = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) last.current = Date.now();
    };
    editor.on("transaction", on);
    return () => void editor.off("transaction", on);
  }, [editor]);
  return () => Date.now() - last.current > 1500;
}

export function BlockRefView(props: ReactNodeViewProps) {
  const { node, editor, getPos, selected } = props;
  const b = useBridge();
  const { compact } = useShell();
  const a = node.attrs as { fileId: string; refBlockId: string; title: string; snapshot?: { markdown?: string } | null };
  const wrap = useRef<HTMLDivElement>(null);
  const [proj, setProj] = useState<Projection | null>(() => lastProjection(a.fileId, a.refBlockId) ?? null);
  const [state, setState] = useState<"ok" | "updating" | "noaccess" | "gone" | "stale">("updating");
  const [flash, setFlash] = useState(false);
  const [fresh, setFresh] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const now = useNow(5000);
  const paused = useTypingPause(editor);
  const visible = useRef(false);
  const pending = useRef<Projection | null>(null);
  const host = hostName(b);
  const pos = () => (typeof getPos === "function" ? getPos() : undefined);

  const load = useCallback(
    async (first: boolean) => {
      if (!first) setState((s) => (s === "ok" || s === "stale" ? "updating" : s));
      try {
        const r = await projection(a.fileId, a.refBlockId);
        setState("ok");
        if (r.changed || first) {
          const apply = (p: Projection) => {
            setProj(p);
            if (!first) {
              setFlash(true);
              setFresh(Date.now());
              setSaid("Reference updated");
              window.setTimeout(() => setFlash(false), 1200);
            }
          };
          // No reflow while the person types nearby: wait for a pause.
          if (paused() || first) apply(r.p);
          else pending.current = r.p;
        }
      } catch (e) {
        const k = (e as { kind?: string }).kind;
        setState(k === "noaccess" ? "noaccess" : k === "gone" ? "gone" : k === "notembedded" ? "updating" : "stale");
        if (k === "notembedded") window.setTimeout(() => void load(true), 800);
      }
    },
    [a.fileId, a.refBlockId, paused],
  );

  useEffect(() => {
    void load(true);
    const io = new IntersectionObserver((es) => (visible.current = es.some((e) => e.isIntersecting)));
    if (wrap.current) io.observe(wrap.current);
    const t = window.setInterval(() => {
      if (pending.current && paused()) {
        const p = pending.current;
        pending.current = null;
        setProj(p);
        setFlash(true);
        setFresh(Date.now());
        setSaid("Reference updated");
        window.setTimeout(() => setFlash(false), 1200);
      }
      if (visible.current && document.visibilityState === "visible") void load(false);
    }, POLL_MS);
    const focus = () => void load(false);
    window.addEventListener("focus", focus);
    return () => {
      io.disconnect();
      window.clearInterval(t);
      window.removeEventListener("focus", focus);
    };
  }, [load, paused]);

  const title = a.title || proj?.name || "";
  const from = proj?.name && proj.name !== a.title ? proj.name : "";
  const open = () => openSource(a.fileId, a.refBlockId);
  const remove = () => {
    const at = pos();
    if (at === undefined) return;
    editor.chain().focus().deleteRange({ from: at, to: at + node.nodeSize }).run();
  };
  const justNow = fresh && now - fresh < 10_000;
  const status = state === "updating" && proj ? "Updating" : justNow ? "Updated just now" : ago(proj?.at ?? null, now);

  if (state === "noaccess" && liveCfg.get().snapshot === "none" && !a.title)
    return (
      <NodeViewWrapper className={"rf" + (selected ? " sel" : "")} data-ref-file={a.fileId} data-state="noaccess" ref={wrap}>
        <div className="lb-na solo" contentEditable={false}>
          <Ic name="eye-off" size={18} />
          <div>
            <b>A reference you can’t open</b>
            Its title and content are hidden. Ask the person who shared this canvas.
          </div>
        </div>
      </NodeViewWrapper>
    );
  return (
    <NodeViewWrapper className={"rf" + (flash ? " flash" : "") + (selected ? " sel" : "") + (compact ? " c" : "")} data-ref-file={a.fileId} data-state={state} ref={wrap}>
      <div className="rf-h" contentEditable={false}>
        <span className="rf-k">
          <Ic name="link-2" size={12} />
          Reference
        </span>
        <span className="lb-t">{title || "Block reference"}</span>
        {from && !compact ? <span className="lb-src">from {from}</span> : null}
        <span className="lb-sp" />
        {status && state !== "noaccess" && state !== "gone" ? (
          <span className={"rf-up" + (justNow ? " ok" : "")}>
            {state === "updating" && proj ? <Ic name="loader-circle" size={12} className="spin" /> : null}
            {status}
          </span>
        ) : null}
        {state !== "noaccess" && state !== "gone" ? (
          <button className="ib" title="Open source" aria-label="Open source" onClick={open}>
            <Ic name="external-link" size={15} />
          </button>
        ) : null}
        <button className={"ib" + (menu ? " on" : "")} aria-label="Reference options" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(e.currentTarget)}>
          <Ic name="ellipsis" size={16} />
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
      {state === "noaccess" ? (
        <div className="lb-na" contentEditable={false}>
          <Ic name="lock" size={18} />
          <div>
            <b>You don’t have access to this block</b>
            It belongs to another canvas in {host}. Ask its owner, or request access there.
          </div>
          <button className="btn sm" onClick={() => openSource(a.fileId, a.refBlockId, "request")}>
            Request access
          </button>
        </div>
      ) : state === "gone" ? (
        <div className="lb-na" contentEditable={false}>
          <Ic name="octagon-alert" size={18} />
          <div>
            <b>The block this refers to was deleted or moved</b>
            Nothing else in this canvas changed.
          </div>
          {editor.isEditable ? (
            <button className="btn sm" onClick={remove}>
              Remove
            </button>
          ) : null}
        </div>
      ) : (
        <div className="rf-b lv" contentEditable={false}>
          {state === "stale" ? (
            <p className="lv-stale">
              <Ic name="cloud-off" size={13} /> Not up to date{proj ? ` · copy from ${hm(proj.at)}` : ""}
            </p>
          ) : null}
          {proj ? <Projected doc={proj.doc} /> : a.snapshot?.markdown ? <SnapshotText markdown={a.snapshot.markdown} /> : <div className="lv-skel" aria-hidden="true"><i /><i /></div>}
        </div>
      )}
      {menu ? (
        <Popover anchor={menu} onClose={() => setMenu(null)} title={compact ? title : "Reference options"} alignRight minWidth={220}>
          <button
            className="mi"
            onClick={() => {
              setMenu(null);
              open();
            }}
          >
            <Ic name="external-link" />
            Open source
          </button>
          <button
            className="mi"
            onClick={() => {
              setMenu(null);
              void copyBlockLink({ fileId: a.fileId, blockId: a.refBlockId }, title || a.fileId).then(() => toast("Link copied", { icon: "link" }));
            }}
          >
            <Ic name="link" />
            Copy link
          </button>
          <button
            className="mi"
            onClick={() => {
              setMenu(null);
              void load(false);
            }}
          >
            <Ic name="refresh-cw" />
            Refresh
          </button>
          {editor.isEditable ? (
            <>
              <div className="msep" />
              <button
                className="mi danger"
                onClick={() => {
                  setMenu(null);
                  remove();
                }}
              >
                <Ic name="trash-2" />
                Remove from this canvas
              </button>
            </>
          ) : null}
        </Popover>
      ) : null}
    </NodeViewWrapper>
  );
}

/** Test hook: the page's live block rooms. */
export function useLiveDebug() {
  return useSyncExternalStore(
    () => () => undefined,
    () => 0,
  );
}
