// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The compact embed of one live file (LIVE-06, frames 4a and 4b): `<open-canvas view="block">`.
// No top bar, no gallery, no document header: the live block's own header (Live mark, title,
// people, options; no source path, the host shows its own context) over the editor, and the
// height follows the content (`UI_Resize {height}`, at most once per animation frame). Lazy.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { BlockEnv, OcUser } from "@opencanvas/ui";
import { ExternalLink, Radio, Link, Ellipsis } from "lucide-react";
import { ICONS, Ic } from "../icons";
import { BridgeCtx, setBridge, type Bridge } from "../lib/bridge";
import { Avatar, Popover, ShellCtx, Toasts } from "../components/overlay";
import { postToHost } from "../lib/host";
import { toast } from "../lib/store";
import { usePeers } from "../lib/presence";
import { resolveAsset } from "../lib/assets";
import { CanvasEditor } from "../editor/CanvasEditor";
import type { Collab, Session } from "../lib/session";
import { copyBlockLink } from "./state";
import "./live.css";

Object.assign(ICONS, { "external-link": ExternalLink, radio: Radio, link: Link, ellipsis: Ellipsis });

/** People in the block: three avatars, then a count (4b). */
function Stack({ collab }: { collab: Collab }) {
  const peers = usePeers(collab.awareness).filter((p) => !p.me && !p.agent);
  if (!peers.length) return null;
  return (
    <span className="lb-ppl" role="img" aria-label={`${peers.length} ${peers.length === 1 ? "person" : "people"} here: ${peers.map((p) => p.name).join(", ")}`}>
      {peers.slice(0, 3).map((p) => (
        <Avatar key={p.id} name={p.name} color={p.color} avatar={p.avatar} cls="xs" />
      ))}
      {peers.length > 3 ? <span className="lb-more">+{peers.length - 3}</span> : null}
    </span>
  );
}

export default function BlockEmbed({ session, collab }: { session: Session; collab: Collab }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [, setEditor] = useState<Editor | null>(null);
  const me: OcUser = useMemo(() => ({ id: session.user.id, name: session.user.name, color: session.user.color, avatar: session.user.avatar ?? undefined }), [session.user]);
  const host = session.host.name || "your app";
  const title = session.file.name;

  const env: BlockEnv = useMemo(
    () => ({ role: session.role, me, users: [], compact, toast: (m, action) => toast(m, { action }), resolveAsset }),
    [session.role, me, compact],
  );
  const b: Bridge = useMemo(
    () => ({
      doc: collab.doc,
      awareness: collab.awareness,
      env,
      session,
      importCsv: () => toast(`Open it in ${host} to import.`),
      promptUrl: () => toast(`Open it in ${host} to add links.`),
      pickFile: () => undefined,
      upload: () => Promise.reject(new Error("uploads are off in the compact view")),
      openThread: () => undefined,
      linkClick: (url) => postToHost("UI_Link_Click", { url }),
    }),
    [collab, env, session, host],
  );
  setBridge(b);

  useEffect(() => {
    document.documentElement.classList.add("oc-block-view");
    postToHost("App_LoadingStatus", { Status: "Document_Loaded" });
    return () => document.documentElement.classList.remove("oc-block-view");
  }, []);

  // 4b: the body reflows; the host is told the height, once per frame at most.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let raf = 0;
    let last = -1;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = Math.ceil(el.getBoundingClientRect().height);
        setCompact(el.getBoundingClientRect().width < 45 * 16);
        if (h !== last) {
          last = h;
          postToHost("UI_Resize", { height: h });
        }
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <ShellCtx.Provider value={{ root, compact }}>
      <BridgeCtx.Provider value={b}>
        <div
          className="oc-embed-root"
          ref={(el) => {
            rootRef.current = el;
            setRoot(el);
          }}
        >
          <section className="lb embed" aria-label={`Live block: ${title}`} data-state="connected">
            <div className="lb-h">
              <span className="lb-live">
                <Ic name="radio" size={12} />
                Live
              </span>
              <h1 className="lb-t">{title}</h1>
              {session.role !== "edit" ? (
                <span className="lb-ro">
                  <Ic name="eye" size={12} />
                  View only
                </span>
              ) : null}
              <span className="lb-sp" />
              <Stack collab={collab} />
              <button className={"ib" + (menu ? " on" : "")} aria-label="Live block options" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(e.currentTarget)}>
                <Ic name="ellipsis" size={16} />
              </button>
            </div>
            <div className="lb-b">
              <CanvasEditor nested doc={collab.doc} awareness={collab.awareness} role={session.role} me={me} users={[]} searchUsers={async () => []} onReady={setEditor} onComment={() => undefined} />
            </div>
          </section>
          {menu ? (
            <Popover anchor={menu} onClose={() => setMenu(null)} title={compact ? title : "Live block options"} alignRight minWidth={220}>
              <button
                className="mi"
                onClick={() => {
                  setMenu(null);
                  postToHost("UI_LiveBlockOpen", { fileId: session.file.id });
                }}
              >
                <Ic name="external-link" />
                Open source in {host}
              </button>
              <button
                className="mi"
                onClick={() => {
                  setMenu(null);
                  void copyBlockLink({ fileId: session.file.id, live: true }, title).then(() => toast("Link copied", { icon: "link" }));
                  postToHost("UI_LiveBlockLink", { fileId: session.file.id });
                }}
              >
                <Ic name="link" />
                Copy link
              </button>
            </Popover>
          ) : null}
          <Toasts />
        </div>
      </BridgeCtx.Provider>
    </ShellCtx.Provider>
  );
}
