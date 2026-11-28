// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The app shell (3a, 10a): sidebar with the workspace tree, Home and folder views as a grid or a
// list, the typed New menu (13a, 13j) and the templates dialog (3b).

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bell, ChevronDown, ChevronRight, ChevronsUpDown, CircleCheck, X, Clock, Folder, FolderPlus, Home, LayoutGrid, LayoutTemplate, List, Lock, LogOut,
  Menu, Plus, Search, Settings2, Star, Trash2, Upload, User, Users,
} from "lucide-react";
import { ago, api, TYPES, type Card, type FileType, type Me, type Space } from "./api";
import { go, onLink } from "./router";
import { Avatar, Empty, Modal, TypeIcon, TypeTile, useToast } from "./ui";

export interface AppData {
  me: Me;
  spaces: Space[];
  recent: Card[];
  favourites: number;
  reload: () => Promise<void>;
  openSearch: () => void;
  openNew: (where?: { workspaceId: string; folderId?: string | null }) => void;
}

export const AppCtx = createContext<AppData>(null as unknown as AppData);
export const useApp = () => useContext(AppCtx);

/** Where "New" creates: the current folder or workspace, else the first one I can edit. */
export function defaultPlace(spaces: Space[], path: string): { workspaceId: string; folderId?: string | null } | null {
  const f = path.match(/^\/f\/([\w-]+)/)?.[1];
  if (f) {
    const s = spaces.find((w) => w.folders.some((x) => x.id === f));
    if (s) return { workspaceId: s.id, folderId: f };
  }
  const w = path.match(/^\/w\/([\w-]+)/)?.[1];
  if (w && spaces.some((s) => s.id === w)) return { workspaceId: w };
  const s = spaces.find((x) => !x.personal && x.member) ?? spaces.find((x) => x.member);
  return s ? { workspaceId: s.id } : null;
}

function placeName(spaces: Space[], p: { workspaceId: string; folderId?: string | null }) {
  const s = spaces.find((x) => x.id === p.workspaceId);
  const f = s?.folders.find((x) => x.id === p.folderId);
  return [s?.name, f?.name].filter(Boolean).join(" › ");
}

/** The New menu (13a): the four types, then a template, a folder, import. */
export function NewMenu({ place, onClose, onTemplate, style }: { place: { workspaceId: string; folderId?: string | null }; onClose: () => void; onTemplate: () => void; style?: React.CSSProperties }) {
  const { spaces, reload } = useApp();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const out = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", out), 0);
    return () => document.removeEventListener("mousedown", out);
  }, [onClose]);
  const create = async (type: FileType) => {
    onClose();
    try {
      const r = await api.post<{ id: string }>("/canvases", { type, workspaceId: place.workspaceId, folderId: place.folderId || undefined });
      await reload();
      go(`/c/${r.id}`);
    } catch (e) {
      toast(String((e as Error).message));
    }
  };
  const folder = async () => {
    onClose();
    const name = prompt("Folder name", "New folder");
    if (!name) return;
    try {
      await api.post("/folders", { workspaceId: place.workspaceId, parentId: place.folderId || undefined, name });
      await reload();
      toast(`Folder “${name}” created`);
    } catch (e) {
      toast(String((e as Error).message));
    }
  };
  const keys = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
    if (e.key === "Escape") onClose();
  };
  return (
    <div className="pop newm" role="menu" aria-label="New" ref={ref} onKeyDown={keys} style={style}>
      {TYPES.map((t) => (
        <button className="mi" role="menuitem" key={t.id} onClick={() => create(t.id)}>
          <TypeTile type={t.id} />
          <span className="m">
            <b>{t.label}</b>
            <small>{t.line}</small>
          </span>
        </button>
      ))}
      <div className="sepl" />
      <button className="mi" role="menuitem" onClick={() => (onClose(), onTemplate())}>
        <LayoutTemplate size={16} />
        <span style={{ flex: 1 }}>From a template…</span>
        <kbd>C</kbd>
      </button>
      <button className="mi" role="menuitem" onClick={folder}>
        <FolderPlus size={16} />
        <span style={{ flex: 1 }}>Folder</span>
      </button>
      <button className="mi" role="menuitem" onClick={() => (onClose(), toast("Import: open a new file and use Import in its menu."))}>
        <Upload size={16} />
        <span className="m">
          <span>Import a file</span>
          <small>.xlsx, .csv, .md, .docx, .drawio and more</small>
        </span>
      </button>
      <div className="sepl" />
      <div className="hint" style={{ padding: ".25rem .5rem .375rem" }}>
        Creates in {placeName(spaces, place)}
      </div>
    </div>
  );
}

/** Templates (3b): the four blank types and the organisation's saved templates. */
export function TemplateDialog({ place, onClose }: { place: { workspaceId: string; folderId?: string | null }; onClose: () => void }) {
  const { spaces, reload } = useApp();
  const toast = useToast();
  const [tpls, setTpls] = useState<Card[]>([]);
  const [sel, setSel] = useState<string>("type:document");
  useEffect(() => {
    api.get<{ canvases: Card[] }>("/canvases?view=all").then((r) => setTpls(r.canvases.filter((c) => c.isTemplate)), () => {});
  }, []);
  const create = async () => {
    try {
      const body = sel.startsWith("type:") ? { type: sel.slice(5) } : { templateId: sel };
      const r = await api.post<{ id: string }>("/canvases", { ...body, workspaceId: place.workspaceId, folderId: place.folderId || undefined });
      onClose();
      await reload();
      go(`/c/${r.id}`);
    } catch (e) {
      toast(String((e as Error).message));
    }
  };
  return (
    <Modal
      title="New from a template"
      sub="Pick a starting point. You can change everything after."
      onClose={onClose}
      wide
      footer={
        <>
          <span className="hint" style={{ marginRight: "auto" }}>
            In {placeName(spaces, place)}
          </span>
          <button className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div className="tpl">
        {TYPES.map((t) => (
          <button className="tp" key={t.id} aria-pressed={sel === `type:${t.id}`} onClick={() => setSel(`type:${t.id}`)} onDoubleClick={create}>
            <span className={`pv ${t.tone}`}>
              <TypeIcon type={t.id} size={24} />
            </span>
            <b>Blank {t.label.toLowerCase()}</b>
            <small>{t.line}</small>
          </button>
        ))}
      </div>
      <div className="sub" style={{ marginTop: "1rem" }}>
        <h3>Your organisation's templates</h3>
        <span className="hint" style={{ marginLeft: "auto" }}>
          Saved by admins
        </span>
      </div>
      {tpls.length ? (
        <div className="tpl">
          {tpls.map((t) => (
            <button className="tp" key={t.id} aria-pressed={sel === t.id} onClick={() => setSel(t.id)} onDoubleClick={create}>
              <span className={`pv ${TYPES.find((x) => x.id === t.type)?.tone}`}>
                <TypeIcon type={t.type} size={24} />
              </span>
              <b>{t.name}</b>
              <small>{t.updatedBy ?? ""}</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">No templates yet. An admin can save any file as a template from its menu.</p>
      )}
      <p className="hint" style={{ marginTop: ".75rem" }}>
        A new document also offers the editor's built-in templates when it opens.
      </p>
    </Modal>
  );
}

function SpaceIcon({ s }: { s: Space }) {
  return <span className={`wt t-${s.personal ? "gray" : s.color}`}>{s.personal ? <Lock size={12} /> : <span className="wt-l">{s.name.slice(0, 1).toUpperCase()}</span>}</span>;
}

function Tree({ s, folders, parent, path, depth }: { s: Space; folders: Space["folders"]; parent: string | null; path: string; depth: number }) {
  const kids = folders.filter((f) => f.parentId === parent);
  if (!kids.length || depth > 8) return null;
  return (
    <div className="tree" role="group">
      {kids.map((f) => (
        <div key={f.id}>
          <a className="nv" role="treeitem" href={`/ws/f/${f.id}`} onClick={(e) => onLink(e, `/f/${f.id}`)} aria-current={path === `/f/${f.id}` ? "true" : undefined}>
            <span className="tw" />
            <Folder size={16} />
            <span className="l">{f.name}</span>
          </a>
          <Tree s={s} folders={folders} parent={f.id} path={path} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

export function Sidebar({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const { me, spaces, favourites, openSearch } = useApp();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const nv = (to: string, label: string, icon: ReactNode, extra?: ReactNode) => (
    <a className="nv" href={`/ws${to}`} onClick={(e) => (onLink(e, to), onNavigate?.())} aria-current={path === to ? "true" : undefined}>
      {icon}
      <span className="l">{label}</span>
      {extra}
    </a>
  );
  const signOut = async () => {
    await api.post("/auth/logout").catch(() => {});
    location.href = "/ws/signin";
  };
  return (
    <aside className="sb" aria-label="Sidebar">
      <div className="sb-top">
        <div className="org" aria-label="Organisation">
          <span className="ot t-blue">{me.org.name.slice(0, 1).toUpperCase()}</span>
          <b>{me.org.name}</b>
          <ChevronsUpDown size={14} />
        </div>
        <button className="sbs" onClick={openSearch}>
          <Search size={14} />
          Search
          <kbd>⌘K</kbd>
        </button>
      </div>
      <nav className="sb-b" aria-label="Workspace">
        {nv("/", "Home", <Home size={16} />)}
        {nv("/recent", "Recent", <Clock size={16} />)}
        {nv("/favourites", "Favourites", <Star size={16} />, favourites ? <span className="n">{favourites}</span> : null)}
        {nv("/shared", "Shared with me", <Users size={16} />)}
        <div className="cap">Workspaces</div>
        <div role="tree" aria-label="Workspaces">
          {spaces.map((s) => {
            const isOpen = open[s.id] ?? (path === `/w/${s.id}` || s.folders.some((f) => path === `/f/${f.id}`));
            return (
              <div key={s.id}>
                <div className="nv-row">
                  <button className="nv tw-b" aria-label={isOpen ? `Collapse ${s.name}` : `Expand ${s.name}`} aria-expanded={isOpen} onClick={() => setOpen({ ...open, [s.id]: !isOpen })} disabled={!s.folders.length}>
                    <span className="tw" data-open={isOpen}>
                      {s.folders.length ? <ChevronRight size={14} /> : null}
                    </span>
                  </button>
                  <a className="nv" role="treeitem" href={`/ws/w/${s.id}`} onClick={(e) => (onLink(e, `/w/${s.id}`), onNavigate?.())} aria-current={path === `/w/${s.id}` ? "true" : undefined}>
                    <SpaceIcon s={s} />
                    <span className="l">{s.name}</span>
                    {s.visibility === "private" && !s.personal && <Lock size={12} />}
                  </a>
                </div>
                {isOpen && <Tree s={s} folders={s.folders} parent={null} path={path} depth={0} />}
              </div>
            );
          })}
        </div>
        <div className="cap">More</div>
        {nv("/trash", "Trash", <Trash2 size={16} />)}
        {(me.role === "owner" || me.role === "admin") && nv("/admin/members", "Members and teams", <Users size={16} />)}
        {(me.role === "owner" || me.role === "admin") && nv("/admin/settings", "Settings", <Settings2 size={16} />)}
      </nav>
      <div className="sb-f">
        <Avatar name={me.name} color={me.color} />
        <span className="who">
          <b>{me.name}</b>
          <small>{me.role[0]!.toUpperCase() + me.role.slice(1)}</small>
        </span>
        <a className="btn ic" href="/ws/inbox" onClick={(e) => onLink(e, "/inbox")} aria-label={`Notifications${me.unread ? `, ${me.unread} unread` : ""}`}>
          <Bell size={16} />
          {me.unread > 0 && <span className="dot" />}
        </a>
        <button className="btn ic" onClick={signOut} aria-label="Sign out">
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}

function Thumb({ c }: { c: Card }) {
  if (c.type === "spreadsheet")
    return (
      <div className="thumb thumb-sheet" aria-hidden="true">
        {Array.from({ length: 30 }, (_, k) => (
          <span key={k} className={k < 5 || k % 5 === 0 ? "h" : k === 18 ? "s" : ""} />
        ))}
      </div>
    );
  if (c.type === "whiteboard")
    return (
      <div className="thumb" aria-hidden="true">
        <span className="bx t-amber" style={{ left: "1rem", top: "1rem", width: "4rem", height: "2.5rem" }} />
        <span className="bx t-blue" style={{ left: "6.5rem", top: "2.2rem", width: "4.5rem", height: "3rem" }} />
        <span className="bx t-green" style={{ left: "3rem", top: "4.4rem", width: "3.5rem", height: "2rem" }} />
      </div>
    );
  if (c.type === "database")
    return (
      <div className="thumb" aria-hidden="true">
        <i className="h" />
        {[0, 1, 2, 3].map((r) => (
          <span key={r} style={{ display: "flex", gap: ".35rem" }}>
            <i style={{ flex: 2 }} />
            <i style={{ flex: 1, background: r % 2 ? "var(--green-bg)" : "var(--blue-bg)" }} />
            <i style={{ flex: 1 }} />
          </span>
        ))}
      </div>
    );
  return (
    <div className="thumb" aria-hidden="true">
      <i className="h" />
      <i style={{ width: "92%" }} />
      <i style={{ width: "80%" }} />
      <i style={{ width: "86%" }} />
      <i style={{ width: "40%" }} />
    </div>
  );
}

function where(c: Card) {
  return [c.workspace, c.folder].filter(Boolean).join(" › ");
}

export function FileList({ list, mode, onStar }: { list: Card[]; mode: "grid" | "list"; onStar: (c: Card) => void }) {
  if (mode === "grid")
    return (
      <div className="cg">
        {list.map((c) => (
          <div className="card" key={c.id}>
            <a href={`/ws/c/${c.id}`} onClick={(e) => onLink(e, `/c/${c.id}`)} className="card-a" aria-label={`${c.name}, ${TYPES.find((t) => t.id === c.type)?.label}`}>
              <Thumb c={c} />
              <div className="card-b">
                <b>
                  <TypeTile type={c.type} size="sm" />
                  <span>{c.name}</span>
                </b>
                <small>
                  {where(c)} · {c.updatedBy ? `${c.updatedBy.split(" ")[0]}, ` : ""}
                  {ago(c.updatedAt)}
                </small>
              </div>
            </a>
            <button className="star" aria-label="Favourite" aria-pressed={c.star} onClick={() => onStar(c)}>
              <Star size={14} />
            </button>
          </div>
        ))}
      </div>
    );
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th className="hide-s">Location</th>
            <th className="hide-s">Edited by</th>
            <th>Edited</th>
            <th>
              <span className="sr">Favourite</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr className="rw" key={c.id}>
              <td>
                <a className="nm" href={`/ws/c/${c.id}`} onClick={(e) => onLink(e, `/c/${c.id}`)}>
                  <TypeTile type={c.type} />
                  {c.name}
                </a>
              </td>
              <td className="dimc">{TYPES.find((t) => t.id === c.type)?.label}</td>
              <td className="dimc hide-s">{where(c)}</td>
              <td className="hide-s">{c.updatedBy ?? ""}</td>
              <td className="dimc">{ago(c.updatedAt)}</td>
              <td>
                <button className="btn ic star" style={{ opacity: 1, position: "static", boxShadow: "none" }} aria-label="Favourite" aria-pressed={c.star} onClick={() => onStar(c)}>
                  <Star size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Home, Recent, Favourites, Shared with me, a workspace or a folder. */
export function Browse({ path }: { path: string }) {
  const { me, spaces, recent, reload, openNew } = useApp();
  const toast = useToast();
  const [mode, setMode] = useState<"grid" | "list">(() => (localStorage.getItem("ws.mode") as "grid" | "list") || "grid");
  const [list, setList] = useState<Card[] | null>(null);
  const [ftype, setFtype] = useState<string>("");
  const ws = path.match(/^\/w\/([\w-]+)/)?.[1];
  const folder = path.match(/^\/f\/([\w-]+)/)?.[1];
  const view = path === "/recent" ? "recent" : path === "/favourites" ? "favourites" : path === "/shared" ? "shared" : "";
  const space = spaces.find((s) => s.id === ws) ?? spaces.find((s) => s.folders.some((f) => f.id === folder));
  const folderObj = space?.folders.find((f) => f.id === folder);
  const title = path === "/" ? "Home" : view === "recent" ? "Recent" : view === "favourites" ? "Favourites" : view === "shared" ? "Shared with me" : folderObj?.name ?? space?.name ?? "";
  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (view) q.set("view", view);
    if (folder) q.set("folder", folder);
    else if (ws) q.set("workspace", ws);
    if (ftype) q.set("type", ftype);
    const r = await api.get<{ canvases: Card[] }>(`/canvases?${q}`);
    setList(r.canvases);
  }, [view, folder, ws, ftype]);
  useEffect(() => {
    setList(null);
    load().catch(() => setList([]));
  }, [load]);
  useEffect(() => localStorage.setItem("ws.mode", mode), [mode]);
  const star = async (c: Card) => {
    await (c.star ? api.del(`/canvases/${c.id}/star`) : api.put(`/canvases/${c.id}/star`));
    await Promise.all([load(), reload()]);
  };
  const join = async () => {
    if (!space) return;
    await api.post(`/workspaces/${space.id}/join`);
    await reload();
    toast(`You joined ${space.name}`);
  };
  const subfolders = space?.folders.filter((f) => (folder ? f.parentId === folder : ws ? f.parentId === null : false)) ?? [];
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();
  return (
    <>
      <div className="mn-t">
        <span className="crumbs">
          {folderObj && space && (
            <>
              <a className="par" href={`/ws/w/${space.id}`} onClick={(e) => onLink(e, `/w/${space.id}`)}>
                {space.name}
              </a>
              <span className="sep">›</span>
            </>
          )}
          <span className="cname">{title}</span>
        </span>
        <span className="sp" />
        {space && !space.member && !space.personal && me.role !== "guest" && (
          <button className="btn sec" onClick={join}>
            Join workspace
          </button>
        )}
        <button className="btn pri" onClick={() => openNew(space ? { workspaceId: space.id, folderId: folder } : undefined)} aria-haspopup="menu">
          <Plus size={16} />
          New
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="mn-b">
        {path === "/" && (me.role === "owner" || me.role === "admin") && <Checklist />}
        {path === "/" && (
          <>
            <div className="mn-h" style={{ marginBottom: ".625rem" }}>
              <h2>
                {greeting}, {me.name.split(" ")[0]}
              </h2>
            </div>
            {recent.length > 0 && (
              <>
                <div className="sub" style={{ marginTop: 0 }}>
                  <h3>Continue where you left off</h3>
                </div>
                <div className="cont">
                  {recent.slice(0, 4).map((c) => (
                    <a className="cc" key={c.id} href={`/ws/c/${c.id}`} onClick={(e) => onLink(e, `/c/${c.id}`)}>
                      <TypeTile type={c.type} size="lg" />
                      <span className="m">
                        <b>{c.name}</b>
                        <small>
                          {c.workspace} · {ago(c.updatedAt)}
                        </small>
                      </span>
                    </a>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {path !== "/" && (
          <div className="mn-h">
            <h2>{title}</h2>
            {view === "favourites" && <span className="hint">Starred files, in the order you starred them.</span>}
            {space?.description && <span className="hint">{space.description}</span>}
          </div>
        )}
        {subfolders.length > 0 && (
          <div className="cont" style={{ marginBottom: "1rem" }}>
            {subfolders.map((f) => (
              <a className="cc" key={f.id} href={`/ws/f/${f.id}`} onClick={(e) => onLink(e, `/f/${f.id}`)}>
                <span className="ctile t-gray" style={{ width: "2rem", height: "2rem", borderRadius: ".5rem" }}>
                  <Folder size={16} />
                </span>
                <span className="m">
                  <b>{f.name}</b>
                  <small>Folder</small>
                </span>
              </a>
            ))}
          </div>
        )}
        <div className="sub">
          <h3>{path === "/" ? "Recently edited" : `${list?.length ?? 0} files`}</h3>
          <span className="sp" />
          <select className="rsel gh" aria-label="Type" value={ftype} onChange={(e) => setFtype(e.target.value)}>
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}s
              </option>
            ))}
          </select>
          <span className="seg" role="group" aria-label="Layout">
            <button aria-pressed={mode === "grid"} onClick={() => setMode("grid")}>
              <LayoutGrid size={14} /> Grid
            </button>
            <button aria-pressed={mode === "list"} onClick={() => setMode("list")}>
              <List size={14} /> List
            </button>
          </span>
        </div>
        {list === null ? (
          <div className="loading" aria-busy="true" />
        ) : list.length ? (
          <FileList list={list} mode={mode} onStar={star} />
        ) : view === "shared" ? (
          <Empty icon={<Users size={28} />} title="Nothing shared with you yet" text="When someone shares a file or folder with you, or adds you to a team, it shows up here." />
        ) : view === "favourites" ? (
          <Empty icon={<Star size={28} />} title="No favourites yet" text="Star a file to keep it here and at the top of the sidebar." />
        ) : (
          <Empty icon={<Folder size={28} />} title={`Nothing in ${title} yet`} text="Create the first file here, or move files in from another workspace.">
            <button className="btn pri" onClick={() => openNew(space ? { workspaceId: space.id, folderId: folder } : undefined)}>
              <Plus size={14} />
              New
            </button>
          </Empty>
        )}
      </div>
    </>
  );
}

/** The setup checklist for admins (1c, 3a), until each item is done or it is dismissed. */
function Checklist() {
  const [c, setC] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    api.get<Record<string, boolean>>("/admin/checklist").then(setC, () => {});
  }, []);
  if (!c || c.dismissed) return null;
  const items: [string, string, string][] = [
    ["account", "Create your account", "/"],
    ["invite", "Invite people", "/admin/members"],
    ["signIn", "Choose sign-in rules", "/admin/settings"],
    ["email", "Set up e-mail (optional)", "/admin/settings"],
    ["backup", "Set up backups", "/admin/settings"],
  ];
  const done = items.filter(([k]) => c[k]).length;
  if (done === items.length) return null;
  return (
    <div className="chkl" role="region" aria-label="Finish setting up">
      <span style={{ display: "flex", flexDirection: "column", gap: ".125rem" }}>
        <b>Finish setting up</b>
        <span className="pr">
          {done} of {items.length} done
        </span>
      </span>
      <span className="its">
        {items.map(([k, label, to]) => (
          <button key={k} className={`chip ${c[k] ? "dn" : ""}`} onClick={() => !c[k] && go(to)} disabled={c[k]}>
            {c[k] ? <CircleCheck size={14} /> : <ChevronRight size={14} />}
            {label}
          </button>
        ))}
      </span>
      <button className="btn ic" aria-label="Dismiss checklist" onClick={() => api.post("/admin/checklist/dismiss").then(() => setC({ ...c, dismissed: true }))}>
        <X size={16} />
      </button>
    </div>
  );
}

/** The phone's bottom bar (10a). */
export function Dock({ path }: { path: string }) {
  const { openSearch, openNew, me } = useApp();
  const items: [string, string, ReactNode, (() => void) | null][] = [
    ["/", "Home", <Home size={20} key="h" />, null],
    ["search", "Search", <Search size={20} key="s" />, openSearch],
    ["new", "New", <Plus size={20} key="n" />, () => openNew()],
    ["/inbox", "Inbox", <Bell size={20} key="b" />, null],
    ["/me", "You", <User size={20} key="u" />, null],
  ];
  return (
    <nav className="ph-dock app-dock" aria-label="Main">
      {items.map(([to, label, icon, act]) => (
        <button key={label} className={path === to ? "on" : ""} aria-label={label === "Inbox" && me.unread ? `Inbox, ${me.unread} unread` : label} onClick={() => (act ? act() : go(to))}>
          {icon}
          {label}
        </button>
      ))}
    </nav>
  );
}

export function PhoneTop({ onMenu }: { onMenu: () => void }) {
  const { me } = useApp();
  return (
    <div className="ph-hd app-phone-top">
      <button className="btn ic" aria-label="Menu" style={{ width: "2.75rem", height: "2.75rem" }} onClick={onMenu}>
        <Menu size={20} />
      </button>
      <span className="org" style={{ padding: 0, flex: 1 }}>
        <span className="ot t-blue">{me.org.name.slice(0, 1)}</span>
        <b>{me.org.name}</b>
      </span>
      <Avatar name={me.name} color={me.color} />
    </div>
  );
}
