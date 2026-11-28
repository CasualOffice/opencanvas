// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// A file inside the Workspace (4a, 10b, 13c, 13d): the Workspace header around the engine's
// editor, launched with our token (docs/05 §3, §4 option A). Spreadsheets, whiteboards and
// databases open in the editor's app mode for their type (docs/05 §2f); the header is the same.
// Also the share dialog (5a) and version history.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Building2, Check, Copy, Download, Globe, History, LayoutTemplate, Link2, Lock, MessageSquare, MoreHorizontal, PanelLeft, Pencil, Share, Star, Trash2, UserPlus, Users, X,
} from "lucide-react";
import { ago, api, type Card } from "./api";
import { go, onLink } from "./router";
import { useApp } from "./shell";
import { Avatar, Modal, TypeTile, useToast } from "./ui";

interface Presence {
  id: string;
  name: string;
  color: string;
}

/** The editor frame: posts the launch form into the iframe and speaks the postMessage API. */
export function EditorFrame({
  token,
  onPresence,
  onSaved,
  onClosed,
  renew,
  title,
  postRef,
}: {
  token: string;
  onPresence?: (p: Presence[]) => void;
  onSaved?: (s: "saving" | "saved") => void;
  onClosed?: (why: string) => void;
  renew?: () => Promise<string | null>;
  title: string;
  /** Lets the header send host actions (`Action_OpenPanel`, `Action_Export`; docs/05 §4). */
  postRef?: React.MutableRefObject<((id: string, v?: object) => void) | null>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const name = useRef(`oc-${Math.random().toString(36).slice(2)}`);
  const toast = useToast();
  useEffect(() => {
    const block = new URLSearchParams(location.hash.slice(1)).get("block") || "";
    const f = form.current!;
    (f.elements.namedItem("block") as HTMLInputElement).value = /^[\w-]{1,64}$/.test(block) ? block : "";
    f.submit();
  }, [token]);
  useEffect(() => {
    const post = (MessageId: string, Values: object = {}) => frame.current?.contentWindow?.postMessage({ MessageId, SendTime: Date.now(), Values }, location.origin);
    if (postRef) postRef.current = post;
    const on = async (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      const { MessageId, Values = {} } = (e.data || {}) as { MessageId?: string; Values?: Record<string, unknown> };
      if (MessageId === "App_LoadingStatus" && Values.Status === "Frame_Ready") {
        post("Host_PostmessageReady");
        const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
        post("Action_Theme", { theme: dark ? "dark" : "light" });
      }
      if (MessageId === "Presence_Changed") onPresence?.((Values.users as Presence[]) || []);
      if (MessageId === "Doc_ModifiedStatus") onSaved?.(Values.Modified ? "saving" : "saved");
      if (MessageId === "Doc_Saved") onSaved?.("saved");
      if (MessageId === "Token_Expiring" && renew) {
        const t = await renew();
        post("Action_RefreshToken", t ? { token: t } : { access: "none" });
      }
      if (MessageId === "UI_OpenFile" && typeof Values.fileId === "string" && /^[\w-]{1,64}$/.test(Values.fileId)) {
        const b = typeof Values.blockId === "string" && /^[\w-]{1,64}$/.test(Values.blockId) ? `#block=${Values.blockId}` : "";
        if (Values.newTab) window.open(`/ws/c/${Values.fileId}${b}`, "_blank", "noopener");
        else go(`/c/${Values.fileId}${b}`);
      }
      if (MessageId === "UI_BlockLink" && typeof Values.blockId === "string" && /^[\w-]{1,64}$/.test(Values.blockId)) {
        const url = `${location.origin}/ws/c/${Values.fileId}#block=${Values.blockId}`;
        navigator.clipboard?.writeText(url).catch(() => {});
        toast("Link to the block copied");
      }
      if (MessageId === "Error" && Values.code === "SESSION_CLOSED") onClosed?.(String(Values.message || "other"));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [onPresence, onSaved, onClosed, renew, toast, postRef]);
  return (
    <>
      <form ref={form} method="post" action="/v1/launch" target={name.current} hidden>
        <input type="hidden" name="token" value={token} readOnly />
        <input type="hidden" name="block" />
      </form>
      <iframe ref={frame} name={name.current} title={title} className="editor-frame" allow="clipboard-read; clipboard-write; fullscreen" />
    </>
  );
}

const ROLE_LABEL: Record<string, string> = { full: "Full access", edit: "Can edit", comment: "Can comment", view: "Can view" };

interface Grant {
  principalKind: "user" | "team";
  principalId: string;
  name: string;
  detail: string;
  role: string;
}

interface Shares {
  canEdit: boolean;
  direct: Grant[];
  inherited: { from: string; fromKind: string; fromId: string; grant: Grant }[];
  link: { access: string; role: string; expiresAt: number | null; hasPassword: boolean; url: string; publicAllowed: boolean; publicMaxRole: string; requirePassword: boolean; defaultExpiryDays: number };
}

/** The share dialog (5a): people, teams and e-mails; inherited access; general access. */
export function ShareDialog({ file, onClose }: { file: Card; onClose: () => void }) {
  const { me } = useApp();
  const toast = useToast();
  const [s, setS] = useState<Shares | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("edit");
  const [sugg, setSugg] = useState<{ kind: "user" | "team"; id: string; name: string; detail: string }[]>([]);
  const [pw, setPw] = useState("");
  const load = useCallback(() => api.get<Shares>(`/canvases/${file.id}/shares`).then(setS), [file.id]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  useEffect(() => {
    if (me.role === "guest") return;
    const t = setTimeout(() => {
      api
        .get<{ people: { id: string; name: string; email: string }[]; teams: { id: string; name: string }[] }>(`/people?q=${encodeURIComponent(q)}`)
        .then((r) => setSugg([...r.people.map((p) => ({ kind: "user" as const, id: p.id, name: p.name, detail: p.email })), ...r.teams.map((t) => ({ kind: "team" as const, id: t.id, name: t.name, detail: "Team" }))]))
        .catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [q, me.role]);
  const grant = async (kind: string, id: string, r: string | null, label: string) => {
    try {
      await api.put(`/canvases/${file.id}/shares`, { principalKind: kind, principalId: id, role: r });
      await load();
      toast(r ? `Shared with ${label}` : `Removed ${label}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const invite = async () => {
    const email = q.trim();
    if (!email.includes("@")) return;
    try {
      const r = await api.post<{ url: string }>("/invites", { kind: "canvas", targetId: file.id, role, email });
      await navigator.clipboard?.writeText(r.url).catch(() => {});
      toast(`Invite link for ${email} copied. Send it any way you like.`);
      setQ("");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const setLink = async (access: string, linkRole?: string, extra: object = {}) => {
    try {
      await api.put(`/canvases/${file.id}/link`, { access, role: linkRole ?? s?.link.role, ...extra });
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const copy = async () => {
    if (!s) return;
    await navigator.clipboard?.writeText(s.link.url).catch(() => {});
    toast(s.link.access === "public" ? "Link copied. Anyone with it can open this file." : "Link copied. Only people with access can open it.");
  };
  const matches = q.trim() ? sugg.filter((x) => (x.name + x.detail).toLowerCase().includes(q.toLowerCase())) : [];
  const maxRoles = ["view", "comment", "edit"];
  const cap = maxRoles.indexOf(s?.link.publicMaxRole ?? "view");
  return (
    <Modal
      title={`Share “${file.name}”`}
      sub={[file.workspace, file.folder].filter(Boolean).join(" › ")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn sec" onClick={copy} style={{ marginRight: "auto" }}>
            <Link2 size={14} />
            Copy link
          </button>
          <button className="btn pri" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {!s ? (
        <div className="loading" aria-busy="true" />
      ) : (
        <>
          {s.canEdit && me.role !== "guest" && (
            <div style={{ display: "flex", gap: ".5rem", position: "relative", flexWrap: "wrap" }}>
              <div className="inp" style={{ flex: 1, height: "2.25rem", minWidth: "12rem" }}>
                <UserPlus size={14} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add people, teams or e-mails" aria-label="Add people, teams or e-mails" />
              </div>
              <select className="rsel" aria-label="Role for new people" value={role} onChange={(e) => setRole(e.target.value)}>
                {["edit", "comment", "view", "full"].map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              {q.trim() && (
                <div className="sugg pop" role="listbox">
                  {matches.map((m) => (
                    <button
                      className="mi"
                      role="option"
                      aria-selected="false"
                      key={m.kind + m.id}
                      onClick={() => {
                        setQ("");
                        grant(m.kind, m.id, role, m.name);
                      }}
                    >
                      {m.kind === "team" ? (
                        <span className="av s t-green" style={{ color: "var(--green-fg)" }}>
                          <Users size={12} />
                        </span>
                      ) : (
                        <Avatar name={m.name} small />
                      )}
                      <span style={{ flex: 1, textAlign: "left" }}>
                        <b style={{ fontWeight: 500 }}>{m.name}</b> <small>{m.detail}</small>
                      </span>
                    </button>
                  ))}
                  {!matches.length && q.includes("@") && (
                    <button className="mi" onClick={invite}>
                      <span style={{ flex: 1, textAlign: "left" }}>
                        Invite <b style={{ fontWeight: 500 }}>{q.trim()}</b> <small>No account yet: they get an invite to this file as a Guest</small>
                      </span>
                    </button>
                  )}
                  {!matches.length && !q.includes("@") && <div className="hint" style={{ padding: ".5rem" }}>Nobody matches “{q}”. Type a full e-mail to invite someone.</div>}
                </div>
              )}
            </div>
          )}
          <div className="cap" style={{ paddingLeft: 0, marginTop: ".5rem" }}>
            People and teams
          </div>
          {s.direct.map((g) => (
            <div className="shr" key={g.principalKind + g.principalId}>
              <span className="ppl">
                {g.principalKind === "team" ? (
                  <span className="av t-pink" style={{ color: "var(--pink-fg)" }}>
                    <Users size={12} />
                  </span>
                ) : (
                  <Avatar name={g.name} />
                )}
                <span className="m">
                  <b>
                    {g.name}
                    {g.principalId === me.id ? " (you)" : ""}
                  </b>
                  <small>{g.detail}</small>
                </span>
              </span>
              {s.canEdit ? (
                <select className="rsel gh" aria-label={`Role for ${g.name}`} value={g.role} onChange={(e) => grant(g.principalKind, g.principalId, e.target.value === "remove" ? null : e.target.value, g.name)}>
                  {["full", "edit", "comment", "view"].map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                  <option value="remove">Remove</option>
                </select>
              ) : (
                <span className="hint">{ROLE_LABEL[g.role]}</span>
              )}
            </div>
          ))}
          {s.inherited.map((x) => (
            <div className="shr" key={x.fromId + x.grant.principalId}>
              <span className="ppl">
                <span className="av t-blue" style={{ color: "var(--blue-fg)" }}>
                  {x.grant.principalKind === "team" ? <Users size={12} /> : x.grant.name.slice(0, 1)}
                </span>
                <span className="m">
                  <b>{x.grant.name}</b>
                  <small className="inh">From {x.from}</small>
                </span>
              </span>
              <span className="hint">{ROLE_LABEL[x.grant.role] ?? x.grant.role}</span>
            </div>
          ))}
          <div className="cap" style={{ paddingLeft: 0, marginTop: ".5rem" }}>
            General access
          </div>
          <div className="ga">
            <span className={`ic ${s.link.access === "public" ? "t-amber" : s.link.access === "org" ? "t-blue" : "t-gray"}`}>
              {s.link.access === "public" ? <Globe size={14} /> : s.link.access === "org" ? <Building2 size={14} /> : <Lock size={14} />}
            </span>
            <span className="m">
              <select className="rsel gh" style={{ paddingLeft: 0, fontWeight: 500 }} aria-label="General access" value={s.link.access} disabled={!s.canEdit} onChange={(e) => setLink(e.target.value, e.target.value === "public" ? maxRoles[Math.min(maxRoles.indexOf(s.link.role), cap)] : undefined)}>
                <option value="none">Only people added</option>
                <option value="org">Everyone at {me.org.name}</option>
                <option value="public" disabled={!s.link.publicAllowed}>
                  Anyone with the link{s.link.publicAllowed ? "" : " (turned off by an admin)"}
                </option>
              </select>
              <small>
                {s.link.access === "none" && "Only the people and teams above can open it."}
                {s.link.access === "org" && `Anyone signed in to ${me.org.name} can open it. Guests cannot.`}
                {s.link.access === "public" && (
                  <>
                    Anyone on the internet with the link can open it without signing in
                    {s.link.expiresAt ? `, until ${new Date(s.link.expiresAt).toLocaleDateString()}` : ""}
                    {s.link.hasPassword ? ", with a password" : ""}.
                  </>
                )}
              </small>
            </span>
            {s.link.access !== "none" && s.canEdit && (
              <select className="rsel gh" aria-label="Link role" value={s.link.role} onChange={(e) => setLink(s.link.access, e.target.value)}>
                {maxRoles.map((r, i) => (
                  <option key={r} value={r} disabled={s.link.access === "public" && i > cap}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            )}
          </div>
          {s.link.access === "public" && s.canEdit && (
            <div className="link-opts">
              <select className="rsel" aria-label="Link expiry" onChange={(e) => setLink("public", undefined, { expiresDays: Number(e.target.value) })} defaultValue="">
                <option value="" disabled>
                  Change expiry
                </option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="0">Never</option>
              </select>
              <div className="inp" style={{ flex: 1, minWidth: "10rem" }}>
                <Lock size={14} />
                <input type="password" placeholder={s.link.hasPassword ? "Change the password" : "Add a password (optional)"} value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Link password" />
              </div>
              <button className="btn sec" disabled={!pw} onClick={() => setLink("public", undefined, { password: pw }).then(() => setPw(""))}>
                Set
              </button>
              {s.link.hasPassword && (
                <button className="btn" onClick={() => setLink("public", undefined, { password: "" })}>
                  Remove password
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

interface Version {
  version: number;
  at: number;
  kind: string;
  name: string | null;
  authors: string[];
}

function VersionPanel({ file, onClose }: { file: Card; onClose: () => void }) {
  const [list, setList] = useState<Version[] | null>(null);
  useEffect(() => {
    api.get<{ versions: Version[] }>(`/canvases/${file.id}/versions`).then((r) => setList(r.versions), () => setList([]));
  }, [file.id, file.version]);
  const days = new Map<string, Version[]>();
  for (const v of list ?? []) {
    const d = new Date(v.at).toDateString() === new Date().toDateString() ? "Today" : new Date(v.at).toLocaleDateString([], { day: "numeric", month: "short" });
    days.set(d, [...(days.get(d) ?? []), v]);
  }
  return (
    <aside className="vh" aria-label="Version history">
      <div className="vh-h">
        <History size={16} />
        Version history
        <span className="sp" />
        <button className="btn ic" aria-label="Close history" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="vh-b">
        {list && !list.length && <p className="hint" style={{ padding: ".75rem .5rem" }}>Only the current version so far. Earlier versions appear here as people edit; name one from the editor's history menu to keep it forever.</p>}
        {[...days].map(([d, vs]) => (
          <div key={d}>
            <div className="vday">{d}</div>
            {vs.map((v) => (
              <div className="ver" key={v.version}>
                <span className="dt" />
                <span className="m">
                  <b>{v.name ?? new Date(v.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b>
                  <small>
                    Version {v.version} · {ago(v.at)}
                  </small>
                </span>
                {v.kind !== "auto" && <span className={`pill ${v.kind === "named" ? "p-purple" : "p-gray"}`}>{v.kind === "named" ? "Named" : "Restore"}</span>}
              </div>
            ))}
          </div>
        ))}
        <p className="hint" style={{ padding: ".75rem .5rem" }}>
          Every save is kept for 24 hours, then hourly for 7 days and daily for 90 days. Named versions are kept forever. Compare and restore from the editor's history (its clock menu).
        </p>
      </div>
    </aside>
  );
}

export function FilePage({ id, onToggleSidebar }: { id: string; onToggleSidebar: () => void }) {
  const { me, reload } = useApp();
  const toast = useToast();
  const [file, setFile] = useState<Card | null>(null);
  const [location_, setLocation] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [people, setPeople] = useState<Presence[]>([]);
  const [saved, setSaved] = useState<"saving" | "saved">("saved");
  const [share, setShare] = useState(false);
  const [hist, setHist] = useState(false);
  const [more, setMore] = useState(false);
  const [closed, setClosed] = useState("");
  const post = useRef<((id: string, v?: object) => void) | null>(null);
  const load = useCallback(async () => {
    const r = await api.get<{ canvas: Card; location: string }>(`/canvases/${id}`);
    setFile(r.canvas);
    setLocation(r.location);
    return r.canvas;
  }, [id]);
  const launch = useCallback(async () => {
    try {
      const r = await api.post<{ token: string }>(`/canvases/${id}/launch`);
      return r.token;
    } catch {
      return null;
    }
  }, [id]);
  useEffect(() => {
    setFile(null);
    setToken(null);
    setErr("");
    setClosed("");
    load()
      .then(() => launch())
      .then((t) => (t ? setToken(t) : setErr("This file can't be opened.")))
      .catch(() => setErr("This file doesn't exist, or you don't have access to it."));
  }, [load, launch]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setShare(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setHist((h) => !h);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  if (err)
    return (
      <div className="mn-b">
        <div className="emp" style={{ height: "auto", padding: "4rem 1rem" }}>
          <span className="art">
            <Lock size={28} />
          </span>
          <b>Not found</b>
          <p>{err}</p>
          <div className="acts">
            <button className="btn sec" onClick={() => go("/")}>
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  if (!file) return <div className="loading" aria-busy="true" />;
  const full = file.role === "full";
  const parts = location_.split(" › ");
  const act = async (what: string) => {
    setMore(false);
    try {
      if (what === "rename") {
        const n = prompt("Rename", file.name);
        if (n && n.trim()) {
          await api.patch(`/canvases/${id}`, { name: n });
          await load();
          await reload();
        }
      }
      if (what === "duplicate") {
        const r = await api.post<{ id: string }>(`/canvases/${id}/duplicate`);
        await reload();
        toast("Copy made", { label: "Open", run: () => go(`/c/${r.id}`) });
      }
      if (what === "template") {
        await api.patch(`/canvases/${id}`, { isTemplate: !file.isTemplate });
        await load();
        toast(file.isTemplate ? "No longer a template" : "Saved as a template for everyone");
      }
      if (what === "link") {
        await navigator.clipboard?.writeText(`${location.origin}/ws/c/${id}`).catch(() => {});
        toast("Link copied. Only people with access can open it.");
      }
      if (what === "delete") {
        if (!confirm(`Move “${file.name}” to Trash? It is kept 30 days.`)) return;
        await api.del(`/canvases/${id}`);
        await reload();
        toast(`“${file.name}” moved to Trash`, { label: "Undo", run: () => api.post(`/trash/canvas/${id}/restore`).then(() => reload()) });
        go(file.folderId ? `/f/${file.folderId}` : `/w/${file.workspaceId}`);
      }
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const star = async () => {
    await (file.star ? api.del(`/canvases/${id}/star`) : api.put(`/canvases/${id}/star`));
    await load();
    await reload();
  };
  const others = people.filter((p) => p.id !== me.id);
  return (
    <div className={`file-page type-${file.type}`}>
      <div className="cv-t">
        <button className="btn ic hide-s" aria-label="Show or hide the sidebar" onClick={onToggleSidebar}>
          <PanelLeft size={16} />
        </button>
        <button className="btn ic show-s" aria-label={`Back to ${parts[parts.length - 1] || "Home"}`} onClick={() => go(file.folderId ? `/f/${file.folderId}` : `/w/${file.workspaceId}`)}>
          <ArrowLeft size={18} />
        </button>
        <span className="crumbs">
          {parts.map((p, i) => (
            <span key={i} className={`par ${i < parts.length - 1 ? "hide-s" : ""}`}>
              {i === 0 ? (
                <a href={`/ws/w/${file.workspaceId}`} onClick={(e) => onLink(e, `/w/${file.workspaceId}`)}>
                  {p}
                </a>
              ) : (
                p
              )}
              <span className="sep"> › </span>
            </span>
          ))}
          <TypeTile type={file.type} size="sm" />
          <span className="cname">{file.name}</span>
        </span>
        <button className="btn ic star" style={{ opacity: 1, position: "static", boxShadow: "none" }} aria-label="Favourite" aria-pressed={file.star} onClick={star}>
          <Star size={14} />
        </button>
        <span className="ocst hide-s" role="status">
          {saved === "saved" ? (
            <>
              <Check size={14} />
              Saved
            </>
          ) : (
            "Saving…"
          )}
        </span>
        <span className="sp" />
        {others.length > 0 && (
          <span className="stack" aria-label={`${others.map((p) => p.name).join(" and ")} ${others.length === 1 ? "is" : "are"} here`}>
            {others.slice(0, 4).map((p) => (
              <Avatar key={p.id} name={p.name} color={p.color} />
            ))}
            {others.length > 4 && <span className="av" style={{ background: "var(--fg-3)" }}>+{others.length - 4}</span>}
          </span>
        )}
        <button className="btn ic hide-s" aria-label="Comments" onClick={() => post.current?.("Action_OpenPanel", { panel: "comments" })}>
          <MessageSquare size={16} />
        </button>
        <button className={`btn hide-s ${hist ? "on" : ""}`} onClick={() => post.current?.("Action_OpenPanel", { panel: "history" })}>
          <History size={16} />
          History
        </button>
        <button className="btn pri" onClick={() => setShare(true)}>
          <Share size={14} />
          <span className="hide-s">Share</span>
        </button>
        <div style={{ position: "relative" }}>
          <button className="btn ic" aria-label="More" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}>
            <MoreHorizontal size={16} />
          </button>
          {more && (
            <div className="pop more-menu" role="menu">
              <button className="mi" role="menuitem" onClick={() => act("rename")} disabled={file.role === "view" || file.role === "comment"}>
                <Pencil size={14} />
                Rename
              </button>
              <button className="mi" role="menuitem" onClick={() => act("duplicate")}>
                <Copy size={14} />
                Duplicate
              </button>
              <button className="mi" role="menuitem" onClick={() => act("link")}>
                <Link2 size={14} />
                Copy link
              </button>
              <button className="mi show-s" role="menuitem" onClick={() => (setMore(false), post.current?.("Action_OpenPanel", { panel: "history" }))}>
                <History size={14} />
                History
              </button>
              <button className="mi" role="menuitem" onClick={() => (setMore(false), setHist(true))}>
                <History size={14} />
                All saved versions
              </button>
              <div className="sepl" />
              {[["pdf", "PDF"], ["docx", "Word"], ["md", "Markdown"], ["ocanvas", "OpenCanvas file"]].map(([f, l]) => (
                <button className="mi" role="menuitem" key={f} onClick={() => (setMore(false), post.current?.("Action_Export", { format: f }))}>
                  <Download size={14} />
                  Download as {l}
                </button>
              ))}
              {(me.role === "owner" || me.role === "admin") && (
                <button className="mi" role="menuitem" onClick={() => act("template")}>
                  <LayoutTemplate size={14} />
                  {file.isTemplate ? "Stop using as a template" : "Save as template"}
                </button>
              )}
              <div className="sepl" />
              <button className="mi" role="menuitem" onClick={() => act("delete")} disabled={!full}>
                <Trash2 size={14} />
                Move to Trash
              </button>
            </div>
          )}
        </div>
      </div>
      {closed && (
        <div className="banner" role="alert">
          {closed === "revoked" ? "Your access to this file changed." : "This editing session ended."}
          <button className="btn" onClick={() => location.reload()}>
            Reopen
          </button>
        </div>
      )}
      <div className="cv-b">
        {token && <EditorFrame token={token} title={file.name} onPresence={setPeople} onSaved={setSaved} onClosed={setClosed} renew={launch} postRef={post} />}
        {hist && <VersionPanel file={file} onClose={() => setHist(false)} />}
      </div>
      {share && (
        <ShareDialog
          file={file}
          onClose={() => {
            setShare(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/** A public-link visitor's view: a slim header and the editor. */
export function VisitorPage({ launch }: { launch: { token: string; type: string; name: string; role: string } }) {
  return (
    <div className={`file-page visitor type-${launch.type}`}>
      <div className="cv-t">
        <span className="crumbs">
          <TypeTile type={launch.type} size="sm" />
          <span className="cname">{launch.name}</span>
        </span>
        <span className="sp" />
        <span className="pill p-amber">{launch.role === "view" ? "View only" : launch.role === "comment" ? "Can comment" : "Can edit"}</span>
      </div>
      <div className="cv-b">
        <EditorFrame token={launch.token} title={launch.name} />
      </div>
    </div>
  );
}
