// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// OpenCanvas Workspace web app (ADR-085, docs/40; prototype docs/prototypes/workspace).

import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "./proto.css";
import "./app.css";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, type Card, type Me, type Space } from "./api";
import { InviteSignup, LinkVisit, Reset, Setup, SignIn } from "./auth";
import { FilePage, VisitorPage } from "./file";
import { Inbox, Members, MePage, SearchDialog, SettingsPage, TrashPage } from "./pages";
import { go, usePath } from "./router";
import { AppCtx, Browse, defaultPlace, Dock, NewMenu, PhoneTop, Sidebar, TemplateDialog, type AppData } from "./shell";
import { ToastHost } from "./ui";

type Boot = { kind: "loading" } | { kind: "setup"; codeRequired: boolean; publicUrl: string | null } | { kind: "signin" } | { kind: "in"; me: Me };

function Shell({ me, path, onSignedOut }: { me: Me; path: string; onSignedOut: () => void }) {
  const [home, setHome] = useState<{ spaces: Space[]; recent: Card[]; favourites: number }>({ spaces: [], recent: [], favourites: 0 });
  const [meNow, setMe] = useState(me);
  const [search, setSearch] = useState(false);
  const [newAt, setNewAt] = useState<{ workspaceId: string; folderId?: string | null } | null>(null);
  const [tplAt, setTplAt] = useState<{ workspaceId: string; folderId?: string | null } | null>(null);
  const [sbHidden, setSbHidden] = useState(false);
  const [sheet, setSheet] = useState(false);
  const reload = useCallback(async () => {
    try {
      const [h, m] = await Promise.all([api.get<{ workspaces: Space[]; recent: Card[]; favourites: number }>("/home"), api.get<Me>("/me")]);
      setHome({ spaces: h.workspaces, recent: h.recent, favourites: h.favourites });
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
    }
  }, [onSignedOut]);
  useEffect(() => {
    reload();
  }, [reload, path]);
  // Branding (Settings › Branding): the organisation's accent colour.
  useEffect(() => {
    if (/^#[0-9a-f]{6}$/i.test(meNow.org.accent)) document.documentElement.style.setProperty("--accent", meNow.org.accent);
  }, [meNow.org.accent]);
  const openNew = useCallback(
    (where?: { workspaceId: string; folderId?: string | null }) => {
      const p = where ?? defaultPlace(home.spaces, path);
      if (p) setNewAt(p);
    },
    [home.spaces, path],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSbHidden((h) => !h);
      }
      if (!typing && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "c" && !path.startsWith("/c/")) {
        const p = defaultPlace(home.spaces, path);
        if (p) setTplAt(p);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [home.spaces, path]);
  const data: AppData = { me: meNow, spaces: home.spaces, recent: home.recent, favourites: home.favourites, reload, openSearch: () => setSearch(true), openNew };
  const file = path.match(/^\/c\/([\w-]+)/)?.[1];
  let main: React.ReactNode;
  if (file) main = <FilePage id={file} onToggleSidebar={() => setSbHidden((h) => !h)} />;
  else if (path === "/trash") main = <TrashPage />;
  else if (path === "/inbox") main = <Inbox />;
  else if (path === "/me") main = <MePage />;
  else if (path === "/admin/members") main = <Members />;
  else if (path === "/admin/settings") main = <SettingsPage />;
  else main = <Browse path={path} />;
  return (
    <AppCtx.Provider value={data}>
      <div className={`ws app ${sbHidden ? "sb-hidden" : ""} ${file ? "on-file" : ""}`}>
        {!file && <PhoneTop onMenu={() => setSheet(true)} />}
        <Sidebar path={path} />
        <main className="mn" id="main">
          {main}
        </main>
        {!file && <Dock path={path} />}
        {newAt && (
          <div className="newm-host">
            <NewMenu place={newAt} onClose={() => setNewAt(null)} onTemplate={() => setTplAt(newAt)} />
          </div>
        )}
        {tplAt && <TemplateDialog place={tplAt} onClose={() => setTplAt(null)} />}
        {search && <SearchDialog onClose={() => setSearch(false)} />}
        {sheet && (
          <div className="mask app-mask phone-sheet" onMouseDown={(e) => e.target === e.currentTarget && setSheet(false)}>
            <div className="sheet-side" role="dialog" aria-label="Workspaces">
              <Sidebar path={path} onNavigate={() => setSheet(false)} />
            </div>
          </div>
        )}
      </div>
    </AppCtx.Provider>
  );
}

function App() {
  const path = usePath();
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const [visit, setVisit] = useState<{ token: string; type: string; name: string; role: string } | null>(null);
  const check = useCallback(async () => {
    const st = await api.get<{ needsSetup: boolean; codeRequired: boolean; publicUrl: string | null }>("/setup");
    if (st.needsSetup) return setBoot({ kind: "setup", codeRequired: st.codeRequired, publicUrl: st.publicUrl });
    try {
      setBoot({ kind: "in", me: await api.get<Me>("/me") });
    } catch {
      setBoot({ kind: "signin" });
    }
  }, []);
  useEffect(() => {
    check();
  }, [check]);
  const invite = path.match(/^\/invite\/([\w-]+)/)?.[1];
  const reset = path.match(/^\/reset\/([\w-]+)/)?.[1];
  const link = path.match(/^\/l\/([\w-]+)/)?.[1];
  if (link) return visit ? <VisitorPage launch={visit} /> : <LinkVisit token={link} onOpen={setVisit} />;
  if (invite) return <InviteSignup token={invite} onDone={(next) => (go(next.replace(/^\/ws/, ""), true), check())} />;
  if (reset) return <Reset token={reset} />;
  if (boot.kind === "loading") return <div className="loading" aria-busy="true" />;
  if (boot.kind === "setup") return <Setup codeRequired={boot.codeRequired} publicUrl={boot.publicUrl} onDone={() => (go("/", true), check())} />;
  if (boot.kind === "signin" || path === "/signin") {
    if (boot.kind === "in") {
      go("/", true);
      return null;
    }
    return <SignIn onDone={() => (go(path === "/signin" ? "/" : path, true), check())} />;
  }
  return <Shell me={boot.me} path={path} onSignedOut={() => setBoot({ kind: "signin" })} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>,
);
