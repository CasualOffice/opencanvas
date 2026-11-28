// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Search and ⌘K (6a), Trash (7a), the inbox, members and teams (8a), settings (9a) and the
// person's own page.

import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, Bell, Folder, Info, Link2, Lock, Search, Share, Trash2, Undo2, UserPlus, Users } from "lucide-react";
import { ago, api, TYPES } from "./api";
import { addPasskey, deviceName, passkeysSupported } from "./passkey";
import { go, onLink } from "./router";
import { useApp } from "./shell";
import { Avatar, Empty, Modal, TypeTile, useToast } from "./ui";

interface Hit {
  fileId: string;
  title: string;
  path?: string;
  blockId?: string;
  snippet: string;
  updatedAt?: string;
  type: string;
}

function Highlight({ text, q }: { text: string; q: string }) {
  const words = q.toLowerCase().split(/\W+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return (
    <>
      {text.split(re).map((p, i) =>
        i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

/** ⌘K search (6a): titles and text of every file the person can open. */
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { spaces } = useApp();
  const [q, setQ] = useState(() => sessionStorage.getItem("ws.q") || "");
  const [type, setType] = useState("");
  const [space, setSpace] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    sessionStorage.setItem("ws.q", q);
    if (!q.trim()) return setHits(null);
    const t = setTimeout(() => {
      const p = new URLSearchParams({ q });
      if (type) p.set("type", type);
      if (space) p.set("workspace", space);
      api.get<{ items: Hit[] }>(`/search?${p}`).then((r) => (setHits(r.items), setSel(0)), () => setHits([]));
    }, 120);
    return () => clearTimeout(t);
  }, [q, type, space]);
  const open = (h: Hit, tab = false) => {
    const url = `/c/${h.fileId}${h.blockId ? `#block=${h.blockId}` : ""}`;
    if (tab) window.open(`/ws${url}`, "_blank", "noopener");
    else {
      onClose();
      go(url);
    }
  };
  const key = (e: React.KeyboardEvent) => {
    if (!hits?.length) return;
    if (e.key === "ArrowDown") (e.preventDefault(), setSel(Math.min(hits.length - 1, sel + 1)));
    if (e.key === "ArrowUp") (e.preventDefault(), setSel(Math.max(0, sel - 1)));
    if (e.key === "Enter") open(hits[sel]!, e.metaKey || e.ctrlKey);
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="mask app-mask" style={{ placeItems: "start center", background: "rgba(10,10,14,.22)" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search">
        <div className="cmdk-i">
          <Search size={20} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={key}
            placeholder="Search files"
            aria-label="Search files"
            role="combobox"
            aria-expanded={!!hits?.length}
            aria-controls="ws-results"
            aria-activedescendant={hits?.length ? `hit-${sel}` : undefined}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="cmdk-f">
          {[{ id: "", label: "All" }, ...TYPES.map((t) => ({ id: t.id, label: `${t.label}s` }))].map((t) => (
            <button key={t.id} className="chip" aria-pressed={type === t.id} onClick={() => setType(t.id)}>
              {t.label}
            </button>
          ))}
          <span className="sp" />
          <select className="rsel gh" aria-label="Workspace" value={space} onChange={(e) => setSpace(e.target.value)}>
            <option value="">Any workspace</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="cmdk-b" id="ws-results" role="listbox" aria-label="Results">
          {hits === null ? (
            <p className="hint" style={{ padding: "1rem" }}>
              Titles, text, database rows and board text in every file you can open.
            </p>
          ) : !hits.length ? (
            <Empty icon={<Search size={28} />} title={`No files match “${q}”`} text="Check the spelling, or search every workspace. Files you cannot open never show up here." />
          ) : (
            <>
              <div className="cap" style={{ paddingLeft: ".5rem" }}>
                {hits.length} result{hits.length > 1 ? "s" : ""}
              </div>
              {hits.map((h, k) => (
                <div id={`hit-${k}`} key={h.fileId + (h.blockId ?? "") + k} className={`sr ${k === sel ? "on" : ""}`} role="option" aria-selected={k === sel} onClick={() => open(h)} onMouseEnter={() => setSel(k)}>
                  <TypeTile type={h.type} size="lg" />
                  <span className="m">
                    <b>
                      <Highlight text={h.title} q={q} />
                    </b>
                    {h.path && <span className="pth">{h.path}</span>}
                    {h.snippet && (
                      <p>
                        <Highlight text={h.snippet} q={q} />
                      </p>
                    )}
                  </span>
                  {h.updatedAt && <span className="hint">{ago(Date.parse(h.updatedAt))}</span>}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="cmdk-ft">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open at the match
          </span>
          <span>
            <kbd>⌘Enter</kbd> new tab
          </span>
        </div>
      </div>
    </div>
  );
}

interface TrashItem {
  kind: "canvas" | "folder";
  id: string;
  name: string;
  type?: string;
  location?: string;
  deletedByName?: string;
  deletedAt: number;
  purgeAt: number;
  files?: number;
}

export function TrashPage() {
  const { me, reload } = useApp();
  const toast = useToast();
  const admin = me.role === "owner" || me.role === "admin";
  const [who, setWho] = useState(admin ? "all" : "mine");
  const [data, setData] = useState<{ items: TrashItem[]; days: number } | null>(null);
  const [confirm, setConfirm] = useState<TrashItem | null>(null);
  const load = useCallback(() => api.get<{ items: TrashItem[]; days: number }>(`/trash?who=${who}`).then(setData), [who]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  const restore = async (t: TrashItem) => {
    const r = await api.post<{ note?: string }>(`/trash/${t.kind}/${t.id}/restore`);
    await Promise.all([load(), reload()]);
    toast(r.note ? `Restored “${t.name}”. ${r.note}` : `Restored “${t.name}”`, t.kind === "canvas" ? { label: "Open", run: () => go(`/c/${t.id}`) } : undefined);
  };
  const purge = async (t: TrashItem) => {
    await api.del(`/trash/${t.kind}/${t.id}`);
    setConfirm(null);
    await load();
    toast(`“${t.name}” deleted forever`);
  };
  const days = (t: TrashItem) => Math.max(0, Math.ceil((t.purgeAt - Date.now()) / 86_400_000));
  return (
    <>
      <div className="mn-t">
        <span className="crumbs">
          <span className="cname">Trash</span>
        </span>
        <span className="sp" />
        {admin && (
          <span className="seg" role="group" aria-label="Whose">
            <button aria-pressed={who === "mine"} onClick={() => setWho("mine")}>
              Mine
            </button>
            <button aria-pressed={who === "all"} onClick={() => setWho("all")}>
              Everyone's
            </button>
          </span>
        )}
      </div>
      <div className="mn-b">
        <div className="mn-h">
          <h2>Trash</h2>
          <span className="hint">Items are deleted forever after {data?.days ?? 30} days.{admin ? " Change this in Settings." : ""}</span>
        </div>
        {!data ? (
          <div className="loading" aria-busy="true" />
        ) : !data.items.length ? (
          <Empty icon={<Trash2 size={28} />} title="Trash is empty" text={`Deleted files and folders stay here for ${data.days} days, then they are deleted forever.`} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-s">Was in</th>
                  <th className="hide-s">Deleted by</th>
                  <th>Deleted forever in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((t) => (
                  <tr className="rw" key={t.kind + t.id}>
                    <td>
                      <span className="nm">
                        {t.kind === "folder" ? (
                          <span className="ctile t-gray">
                            <Folder size={14} />
                          </span>
                        ) : (
                          <TypeTile type={t.type ?? "document"} />
                        )}
                        {t.name}
                        {t.kind === "folder" && <span className="pill p-gray">{t.files} files</span>}
                      </span>
                    </td>
                    <td className="dimc hide-s">{t.location ?? ""}</td>
                    <td className="hide-s">{t.deletedByName ?? ""}</td>
                    <td>{days(t) <= 5 ? <span className="pill p-amber">{days(t)} days</span> : <span className="dimc">{days(t)} days</span>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn sec" onClick={() => restore(t)}>
                        <Undo2 size={14} />
                        Restore
                      </button>{" "}
                      <button className="btn ic" aria-label={`Delete ${t.name} forever`} onClick={() => setConfirm(t)}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirm && (
        <Modal
          title={`Delete “${confirm.name}” forever?`}
          sub="It and its version history are removed now. This can't be undone."
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn sec" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn dan" onClick={() => purge(confirm)}>
                Delete forever
              </button>
            </>
          }
        >
          {null}
        </Modal>
      )}
    </>
  );
}

interface Note {
  id: string;
  kind: string;
  canvasId?: string;
  blockId?: string;
  excerpt: string;
  at: number;
  read: boolean;
  canvasName?: string;
  byName?: string;
}

export function Inbox() {
  const { reload } = useApp();
  const [items, setItems] = useState<Note[] | null>(null);
  useEffect(() => {
    api.get<{ items: Note[] }>("/notifications").then((r) => setItems(r.items), () => setItems([]));
    api.post("/notifications/read").then(() => reload(), () => {});
  }, [reload]);
  return (
    <>
      <div className="mn-t">
        <span className="crumbs">
          <span className="cname">Inbox</span>
        </span>
      </div>
      <div className="mn-b">
        <div className="mn-h">
          <h2>Inbox</h2>
          <span className="hint">Mentions and files shared with you.</span>
        </div>
        {!items ? (
          <div className="loading" aria-busy="true" />
        ) : !items.length ? (
          <Empty icon={<Bell size={28} />} title="Nothing new" text="When someone mentions you or shares a file with you, it shows up here." />
        ) : (
          <div className="sec">
            {items.map((n) => (
              <a className="sec-r note-row" key={n.id} href={n.canvasId ? `/ws/c/${n.canvasId}${n.blockId ? `#block=${n.blockId}` : ""}` : "#"} onClick={(e) => n.canvasId && onLink(e, `/c/${n.canvasId}${n.blockId ? `#block=${n.blockId}` : ""}`)}>
                <span className={`ic ${n.kind === "mention" ? "t-purple" : "t-blue"}`}>{n.kind === "mention" ? <AtSign size={14} /> : <Share size={14} />}</span>
                <span className="m">
                  <b>
                    {n.kind === "mention" ? `${n.byName ?? "Someone"} mentioned you in ${n.canvasName ?? "a file"}` : `${n.canvasName ?? "A file"} was shared with you`}
                    {!n.read && <span className="pill p-blue" style={{ marginLeft: ".5rem" }}>New</span>}
                  </b>
                  {n.excerpt && <small>{n.excerpt}</small>}
                </span>
                <span className="hint">{ago(n.at)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastActiveAt: number | null;
  signIn: string;
  teams: string[];
}

export function Members() {
  const { me } = useApp();
  const toast = useToast();
  const [tab, setTab] = useState<"members" | "teams" | "invites">("members");
  const [users, setUsers] = useState<User[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string; count: number; members: { id: string; name: string }[] }[]>([]);
  const [invites, setInvites] = useState<{ id: string; kind: string; role: string; email: string | null; expiresAt: number }[]>([]);
  const [inviting, setInviting] = useState(false);
  const [inv, setInv] = useState({ role: "member", email: "" });
  const [link, setLink] = useState("");
  const load = useCallback(async () => {
    const [u, t, i] = await Promise.all([
      api.get<{ users: User[] }>("/admin/users"),
      api.get<{ teams: typeof teams }>("/admin/teams"),
      api.get<{ invites: typeof invites }>("/invites"),
    ]);
    setUsers(u.users);
    setTeams(t.teams);
    setInvites(i.invites);
  }, []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  const patch = async (u: User, body: object) => {
    try {
      await api.patch(`/admin/users/${u.id}`, body);
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const reset = async (u: User) => {
    const r = await api.post<{ url: string }>(`/admin/users/${u.id}/reset-link`);
    await navigator.clipboard?.writeText(r.url).catch(() => {});
    toast(`Reset link for ${u.name} copied (24 hours, single use)`);
  };
  const makeInvite = async () => {
    try {
      const r = await api.post<{ url: string }>("/invites", { kind: "org", role: inv.role, email: inv.email || undefined });
      setLink(r.url);
      await navigator.clipboard?.writeText(r.url).catch(() => {});
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const newTeam = async () => {
    const name = prompt("Team name");
    if (!name) return;
    await api.post("/admin/teams", { name });
    await load();
  };
  const addToTeam = async (tid: string) => {
    const who = prompt("Add who? (name or e-mail)");
    const u = who && users.find((x) => x.email === who.trim().toLowerCase() || x.name.toLowerCase() === who.trim().toLowerCase());
    if (!u) return who && toast("Nobody by that name or e-mail");
    await api.put(`/admin/teams/${tid}/members/${u.id}`);
    await load();
  };
  return (
    <>
      <div className="mn-t">
        <span className="crumbs">
          <span className="par">Admin</span>
          <span className="sep">›</span>
          <span className="cname">Members and teams</span>
        </span>
        <span className="sp" />
        <button className="btn pri" onClick={() => (setInviting(true), setLink(""))}>
          <UserPlus size={14} />
          Invite people
        </button>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ["members", "Members", users.length],
            ["teams", "Teams", teams.length],
            ["invites", "Invites", invites.length],
          ] as const
        ).map(([id, l, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>
            {l} <span className="n">{n}</span>
          </button>
        ))}
      </div>
      <div className="mn-b">
        {tab === "members" && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th className="hide-s">Teams</th>
                  <th className="hide-s">Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr className="rw" key={u.id}>
                    <td>
                      <span className="ppl">
                        <Avatar name={u.name} />
                        <span className="m">
                          <b>
                            {u.name}
                            {u.id === me.id ? " (you)" : ""}
                          </b>
                          <small>{u.email}</small>
                        </span>
                      </span>
                    </td>
                    <td>
                      <select className="rsel gh" aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => patch(u, { role: e.target.value })} disabled={u.id === me.id}>
                        {["owner", "admin", "member", "guest"].map((r) => (
                          <option key={r} value={r}>
                            {r[0]!.toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </select>
                      {u.status === "suspended" && <span className="pill p-red">Suspended</span>}
                    </td>
                    <td className="dimc hide-s">{u.teams.join(", ")}</td>
                    <td className="dimc hide-s">{u.lastActiveAt ? ago(u.lastActiveAt) : "Never"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {u.id !== me.id && (
                        <>
                          <button className="btn" onClick={() => reset(u)}>
                            Reset sign-in
                          </button>
                          <button className="btn" onClick={() => patch(u, { status: u.status === "active" ? "suspended" : "active" })}>
                            {u.status === "active" ? "Suspend" : "Reactivate"}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === "teams" && (
          <>
            <div className="mn-h">
              <span className="hint">Teams are groups you can share files and workspaces with.</span>
              <button className="btn sec" onClick={newTeam}>
                New team
              </button>
            </div>
            {!teams.length ? (
              <Empty icon={<Users size={28} />} title="No teams yet" text="Make a team (Design, Engineering) to share with a group at once." />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <tbody>
                    {teams.map((t) => (
                      <tr className="rw" key={t.id}>
                        <td>
                          <span className="nm">
                            <span className="ctile t-pink">
                              <Users size={14} />
                            </span>
                            {t.name}
                          </span>
                        </td>
                        <td className="dimc">{t.members.map((m) => m.name).join(", ") || "No one yet"}</td>
                        <td style={{ textAlign: "right" }}>
                          <button className="btn" onClick={() => addToTeam(t.id)}>
                            Add person
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {tab === "invites" &&
          (!invites.length ? (
            <Empty icon={<Link2 size={28} />} title="No open invites" text="Invite links you make appear here until they are used or expire." />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {invites.map((i) => (
                    <tr className="rw" key={i.id}>
                      <td>{i.email ?? "Any address (general link)"}</td>
                      <td className="dimc">{i.role}</td>
                      <td className="dimc">expires {new Date(i.expiresAt).toLocaleDateString()}</td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn" onClick={() => api.del(`/invites/${i.id}`).then(load)}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
      {inviting && (
        <Modal
          title={`Invite people to ${me.org.name}`}
          sub="They join with the role you choose. E-mail is optional: copy the link and send it any way you like."
          onClose={() => setInviting(false)}
          footer={
            <button className="btn pri" onClick={makeInvite}>
              <Link2 size={14} />
              {link ? "Make another link" : "Create invite link"}
            </button>
          }
        >
          <div className="fg">
            <label className="lbl" htmlFor="iv-e">
              E-mail (optional)
            </label>
            <div className="inp lg">
              <input id="iv-e" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder="Leave empty for a general link" />
            </div>
          </div>
          <div className="fg">
            <label className="lbl" htmlFor="iv-r">
              Role
            </label>
            <select id="iv-r" className="rsel" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
              <option value="member">Member</option>
              <option value="guest">Guest (sees only what is shared with them)</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {link && (
            <div className="fg">
              <label className="lbl" htmlFor="iv-l">
                Invite link (copied, single use, 7 days)
              </label>
              <div className="inp lg">
                <input id="iv-l" value={link} readOnly onFocus={(e) => e.target.select()} />
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

interface Settings {
  orgName: string;
  publicUrl: string;
  publicLinks: { allowed: boolean; maxRole: string; defaultExpiryDays: number; requirePassword: boolean };
  trashDays: number;
  history: { allHours: number; hourlyDays: number; dailyDays: number };
  signupDomains: string[];
  membersCreateWorkspaces: boolean;
  accent: string;
  signInMessage: string;
  smtp: { enabled: boolean; host: string; port: number; security: string; username: string; password: string; hasPassword: boolean; from: string };
}

function Backups() {
  const toast = useToast();
  const [list, setList] = useState<{ backups: { name: string; bytes: number }[]; dir: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get<NonNullable<typeof list>>("/admin/backups").then(setList, () => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  const now = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ name: string; bytes: number }>("/admin/backups");
      await load();
      toast(`Backup finished · ${(r.bytes / 1e6).toFixed(1)} MB`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3>Backups</h3>
      <p className="hint">A consistent copy of the database and every file, kept in the data volume ({list?.dir ?? "backups/"}). Copy it somewhere safe, with the volume's secrets folder.</p>
      <div className="sec">
        <div className="sec-h">
          {list?.backups.length ? `Last backup: ${list.backups[0]!.name}` : "No backup yet"}
          <span className="sp" />
          <button className="btn pri" onClick={now} disabled={busy}>
            {busy ? "Backing up…" : "Back up now"}
          </button>
        </div>
        {list?.backups.map((b) => (
          <div className="sec-r" key={b.name}>
            <span className="m">
              <b>{b.name}</b>
              <small>{(b.bytes / 1e6).toFixed(1)} MB</small>
            </span>
          </div>
        ))}
      </div>
      <p className="hint">Scheduled backups, S3 targets and restoring with <code>opencanvas-workspace restore</code> come next (WS-20). The secrets folder is not in these copies yet.</p>
    </>
  );
}

export function SettingsPage() {
  const toast = useToast();
  const { reload } = useApp();
  const [pg, setPg] = useState("general");
  const [s, setS] = useState<Settings | null>(null);
  const [locked, setLocked] = useState<{ publicUrl: boolean; publicLinksAllowed: boolean; publicLinksMaxRole: boolean }>({ publicUrl: false, publicLinksAllowed: false, publicLinksMaxRole: false });
  const [about, setAbout] = useState<Record<string, string | number> | null>(null);
  useEffect(() => {
    api.get<{ settings: Settings; locked: typeof locked }>("/admin/settings").then((r) => (setS(r.settings), setLocked(r.locked)));
    api.get<Record<string, string | number>>("/admin/about").then(setAbout, () => {});
  }, []);
  if (!s) return <div className="loading" aria-busy="true" />;
  const save = async (next: Settings) => {
    setS(next);
    try {
      await api.put("/admin/settings", next);
      await reload();
      toast("Saved");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const Lock_ = () => (
    <span className="lockd">
      <Lock size={12} />
      Set by the operator
    </span>
  );
  const Sw = ({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) => (
    <button className="sw" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />
  );
  const R = ({ b, sub, children }: { b: string; sub: string; children: React.ReactNode }) => (
    <div className="sec-r">
      <span className="m">
        <b>{b}</b>
        <small>{sub}</small>
      </span>
      {children}
    </div>
  );
  const pages: [string, string][] = [
    ["general", "General"],
    ["sharing", "Sharing and links"],
    ["brand", "Branding"],
    ["signin", "Sign-in"],
    ["email", "E-mail"],
    ["storage", "Storage and retention"],
    ["backups", "Backups"],
    ["about", "About"],
  ];
  return (
    <>
      <div className="mn-t">
        <span className="crumbs">
          <span className="par">Admin</span>
          <span className="sep">›</span>
          <span className="cname">Settings</span>
        </span>
      </div>
      <div className="stg">
        <nav className="stg-n" aria-label="Settings pages">
          {pages.map(([id, l]) => (
            <button key={id} className="nv" aria-current={pg === id ? "true" : undefined} onClick={() => setPg(id)}>
              <span className="l">{l}</span>
            </button>
          ))}
        </nav>
        <div className="stg-b">
          {pg === "general" && (
            <>
              <h3>General</h3>
              <p className="hint">Your organisation's name and address.</p>
              <div className="sec">
                <R b="Organisation name" sub="Shown on the sign-in page and in invites.">
                  <div className="inp">
                    <input defaultValue={s.orgName} aria-label="Organisation name" onBlur={(e) => e.target.value !== s.orgName && save({ ...s, orgName: e.target.value })} />
                  </div>
                </R>
                <R b="Public address" sub="Used for links. A new address applies to the editor after a restart.">
                  {locked.publicUrl ? (
                    <Lock_ />
                  ) : (
                    <div className="inp">
                      <input defaultValue={s.publicUrl} aria-label="Public address" onBlur={(e) => e.target.value !== s.publicUrl && save({ ...s, publicUrl: e.target.value })} />
                    </div>
                  )}
                </R>
                <R b="Members create workspaces" sub="Off: only admins can.">
                  <Sw on={s.membersCreateWorkspaces} label="Members create workspaces" onChange={(v) => save({ ...s, membersCreateWorkspaces: v })} />
                </R>
              </div>
            </>
          )}
          {pg === "sharing" && (
            <>
              <h3>Sharing and links</h3>
              <p className="hint">What people may share outside the organisation.</p>
              <div className="sec">
                <R b="Public links" sub="Allow “Anyone with the link”, without signing in. Off by default. Turning it off ends every public link at once.">
                  {locked.publicLinksAllowed ? <Lock_ /> : <Sw on={s.publicLinks.allowed} label="Public links" onChange={(v) => save({ ...s, publicLinks: { ...s.publicLinks, allowed: v } })} />}
                </R>
                <R b="Highest role a public link gives" sub="Lowering it lowers existing links too.">
                  {locked.publicLinksMaxRole ? (
                    <Lock_ />
                  ) : (
                    <select className="rsel" aria-label="Highest role" value={s.publicLinks.maxRole} onChange={(e) => save({ ...s, publicLinks: { ...s.publicLinks, maxRole: e.target.value } })}>
                      <option value="view">Can view</option>
                      <option value="comment">Can comment</option>
                      <option value="edit">Can edit</option>
                    </select>
                  )}
                </R>
                <R b="Default expiry" sub="For new public links.">
                  <select className="rsel" aria-label="Default expiry" value={s.publicLinks.defaultExpiryDays} onChange={(e) => save({ ...s, publicLinks: { ...s.publicLinks, defaultExpiryDays: Number(e.target.value) } })}>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={0}>Never</option>
                  </select>
                </R>
                <R b="Require a password" sub="Every public link needs a password.">
                  <Sw on={s.publicLinks.requirePassword} label="Require a password" onChange={(v) => save({ ...s, publicLinks: { ...s.publicLinks, requirePassword: v } })} />
                </R>
              </div>
            </>
          )}
          {pg === "signin" && (
            <>
              <h3>Sign-in</h3>
              <p className="hint">E-mail and password or a passkey, with invite links. Single sign-on is on the roadmap.</p>
              <div className="sec">
                <R b="Open sign-up domains" sub="People with these e-mail domains may sign up without an invite. Comma separated; empty = invite only.">
                  <div className="inp">
                    <input defaultValue={s.signupDomains.join(", ")} aria-label="Open sign-up domains" onBlur={(e) => save({ ...s, signupDomains: e.target.value.split(",").map((d) => d.trim()).filter(Boolean) })} />
                  </div>
                </R>
              </div>
            </>
          )}
          {pg === "brand" && (
            <>
              <h3>Branding</h3>
              <p className="hint">How the sign-in page and the app look to your people. “OpenCanvas Workspace by CasualOffice” stays in the footer.</p>
              <div className="sec">
                <R b="Accent colour" sub="Buttons, links and focus rings.">
                  <span className="swatch">
                    {["#2a5ad7", "#7a45f0", "#0e9a78", "#e5602a", "#d63f78", "#18181b"].map((c) => (
                      <button key={c} style={{ background: c, color: c }} aria-label={`Accent ${c}`} aria-pressed={s.accent === c} onClick={() => save({ ...s, accent: c })} />
                    ))}
                  </span>
                </R>
                <R b="Sign-in page message" sub="A short line under the title, up to 280 characters.">
                  <div className="inp">
                    <input defaultValue={s.signInMessage} aria-label="Sign-in page message" onBlur={(e) => e.target.value !== s.signInMessage && save({ ...s, signInMessage: e.target.value })} />
                  </div>
                </R>
              </div>
            </>
          )}
          {pg === "email" && (
            <>
              <h3>E-mail</h3>
              <p className="hint">Optional. Without e-mail, invites and password resets are links that admins copy and send themselves.</p>
              <div className="sec">
                <R b="Send e-mail" sub="Invites, mentions and password resets.">
                  <Sw on={s.smtp.enabled} label="Send e-mail" onChange={(v) => save({ ...s, smtp: { ...s.smtp, enabled: v } })} />
                </R>
                {(
                  [
                    ["host", "SMTP server", "smtp.example.com"],
                    ["port", "Port", "587"],
                    ["username", "User name", ""],
                    ["password", s.smtp.hasPassword ? "Password (set; type to change)" : "Password", ""],
                    ["from", "From", "Canvas <canvas@example.com>"],
                  ] as const
                ).map(([k, label, ph]) => (
                  <R b={label} sub="" key={k}>
                    <div className="inp">
                      <input
                        type={k === "password" ? "password" : k === "port" ? "number" : "text"}
                        defaultValue={k === "password" ? "" : String(s.smtp[k])}
                        placeholder={ph}
                        aria-label={label}
                        onBlur={(e) => {
                          const v = k === "port" ? Number(e.target.value) : e.target.value;
                          if (k === "password" ? v !== "" : v !== s.smtp[k]) save({ ...s, smtp: { ...s.smtp, [k]: v } });
                        }}
                      />
                    </div>
                  </R>
                ))}
                <R b="Security" sub="STARTTLS on 587 is the usual choice.">
                  <select className="rsel" aria-label="Security" value={s.smtp.security} onChange={(e) => save({ ...s, smtp: { ...s.smtp, security: e.target.value } })}>
                    <option value="starttls">STARTTLS</option>
                    <option value="tls">TLS</option>
                    <option value="none">None</option>
                  </select>
                </R>
              </div>
              <p className="hint">Sending is the next step (WS-08): the settings are kept now, and invites stay copyable links.</p>
            </>
          )}
          {pg === "backups" && <Backups />}
          {pg === "storage" && (
            <>
              <h3>Storage and retention</h3>
              <p className="hint">Files and their versions are kept in the data volume.</p>
              <div className="sec">
                <R b="Trash" sub="Days before deleted files are removed for good (1 to 365).">
                  <div className="inp" style={{ width: "6rem" }}>
                    <input type="number" min={1} max={365} defaultValue={s.trashDays} aria-label="Trash days" onBlur={(e) => Number(e.target.value) !== s.trashDays && save({ ...s, trashDays: Number(e.target.value) })} />
                  </div>
                </R>
                <R b="Version history" sub={`Every save for ${s.history.allHours} hours, hourly for ${s.history.hourlyDays} days, daily for ${s.history.dailyDays} days; named versions forever.`}>
                  <span className="dimc">Default</span>
                </R>
              </div>
            </>
          )}
          {pg === "about" && about && (
            <>
              <h3>About</h3>
              <p className="hint">Versions and licence.</p>
              <div className="sec">
                <R b="OpenCanvas Workspace" sub={`Version ${about.version} · by CasualOffice · ${about.license}`}>
                  <Info size={16} />
                </R>
                <R b="Data" sub={`${about.database} · ${about.storage} · ${about.canvases} files · ${about.users} people`}>
                  <span />
                </R>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function MePage() {
  const { me, reload } = useApp();
  const toast = useToast();
  const [name, setName] = useState(me.name);
  const [pw, setPw] = useState({ current: "", password: "" });
  const [keys, setKeys] = useState<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }[]>([]);
  const loadKeys = useCallback(() => api.get<{ passkeys: typeof keys }>("/passkeys").then((r) => setKeys(r.passkeys), () => {}), []);
  useEffect(() => {
    loadKeys();
  }, [loadKeys]);
  const add = async () => {
    try {
      await addPasskey(deviceName());
      await loadKeys();
      toast("Passkey added");
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") toast((e as Error).message);
    }
  };
  const save = async () => {
    try {
      await api.patch("/me", { name });
      await reload();
      toast("Saved");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const change = async () => {
    try {
      await api.post("/me/password", pw);
      setPw({ current: "", password: "" });
      toast("Password changed. Other devices were signed out.");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <>
      <div className="mn-t">
        <span className="crumbs">
          <span className="cname">You</span>
        </span>
      </div>
      <div className="mn-b" style={{ maxWidth: "40rem" }}>
        <div className="mn-h">
          <Avatar name={me.name} color={me.color} />
          <h2>{me.name}</h2>
          <span className="hint">{me.email}</span>
        </div>
        <div className="sec">
          <div className="sec-r">
            <span className="m">
              <b>Name</b>
              <small>Shown to people you work with.</small>
            </span>
            <div className="inp">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            </div>
            <button className="btn sec" onClick={save}>
              Save
            </button>
          </div>
        </div>
        <div className="sec">
          <div className="sec-h">
            Passkeys
            <span className="sp" />
            {passkeysSupported() && (
              <button className="btn sec" onClick={add}>
                Add a passkey
              </button>
            )}
          </div>
          {keys.length ? (
            keys.map((k) => (
              <div className="sec-r" key={k.id}>
                <span className="m">
                  <b>{k.name}</b>
                  <small>
                    Added {ago(k.createdAt)}
                    {k.lastUsedAt ? ` · last used ${ago(k.lastUsedAt)}` : ""}
                  </small>
                </span>
                <button className="btn" onClick={() => api.del(`/passkeys/${encodeURIComponent(k.id)}`).then(loadKeys, (e) => toast((e as Error).message))}>
                  Remove
                </button>
              </div>
            ))
          ) : (
            <div className="sec-r">
              <span className="m">
                <small>Sign in with Touch ID, Windows Hello, your phone or a security key instead of a password.</small>
              </span>
            </div>
          )}
        </div>
        <div className="sec">
          <div className="sec-h">Password</div>
          <div className="sec-r">
            <div className="inp">
              <input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} aria-label="Current password" autoComplete="current-password" />
            </div>
            <div className="inp">
              <input type="password" placeholder="New password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} aria-label="New password" autoComplete="new-password" />
            </div>
            <button className="btn sec" onClick={change} disabled={!pw.password}>
              Change
            </button>
          </div>
        </div>
        <div className="sec">
          <div className="sec-r">
            <span className="m">
              <b>Other sessions</b>
              <small>Sign out everywhere except here.</small>
            </span>
            <button className="btn sec" onClick={() => api.del<{ signedOut: number }>("/auth/sessions/others").then((r) => toast(`Signed out ${r.signedOut} other session${r.signedOut === 1 ? "" : "s"}`))}>
              Sign out others
            </button>
          </div>
        </div>
        <button
          className="btn dan"
          onClick={async () => {
            await api.post("/auth/logout");
            location.href = "/ws/signin";
          }}
        >
          Sign out
        </button>
      </div>
    </>
  );
}
