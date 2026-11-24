// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SDK block chrome (BSDK-03), built to the approved frames (docs/prototypes/block-sdk-approved,
// decisions 1-9):
//   1a at rest: a 1 px frame; the block draws itself inside with the theme tokens it is sent.
//   1b the third-party badge (title · publisher) on hover, focus and selection only (decision 1);
//      a 600 ms hover shows the source, a click or Enter opens About (3a; a sheet on a phone, 5b).
//   1c the loading skeleton at the last known height (kept with the fallback), "Loading <title>"
//      after 2 s, aria-busy.
//   1e a solid 2 px --accent ring with a 2 px gap while focus is inside the frame (decision 2).
//   2a crashed (an error, a hang, out of memory): Reload block; three crashes in a minute make it
//      "Try again later" for 30 s (decision 4). 2b not available (not installed, not enabled,
//      refused at start: one wording, decision 3). 2c updated by a newer version. All show the
//      last saved copy (the block's fallback) read only.
//   3b viewers run the block read only (its ctx role); 4a comments on the whole block (decision 5).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { Ic } from "../icons";
import { useBridge } from "../lib/bridge";
import { Modal, ModalHead, Popover, useShell } from "../components/overlay";
import { useThreads } from "../lib/comments";
import { BlockFrame, readTheme, type FrameState } from "./runtime";
import { currentOf, deriveFallback } from "./derive";
import { EXT_ACTION, blockTitle, focusOnReady, installedBlock, readExtData, registerFocus, statusOf, writeExtData, type BlockPackage, type ExtAttrs } from "./model";
import { SavedCopy } from "./SavedCopy";
import { ExtIcon } from "./ExtIcon";

type Obj = Record<string, unknown>;

/** Decision 4: three crashes within a minute → "Try again later" for 30 s. */
const crashes = new Map<string, number[]>();
export function crashLoop(id: string, now = Date.now()): { locked: boolean; until: number } {
  const recent = (crashes.get(id) ?? []).filter((t) => now - t < 60_000);
  crashes.set(id, recent);
  const locked = recent.length >= 3 && now - recent[recent.length - 1] < 30_000;
  return { locked, until: locked ? recent[recent.length - 1] + 30_000 : 0 };
}
export function noteCrash(id: string, now = Date.now()) {
  crashes.set(id, [...(crashes.get(id) ?? []), now].filter((t) => now - t < 60_000));
}

const newDataId = () => "d_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** What this block can do, in plain words (3a; never "sandbox" or "CSP"). */
export function canDo(pkg: BlockPackage): string[] {
  const out: string[] = [];
  for (const o of pkg.permissions?.network ?? []) out.push(`Connect to ${o.replace(/^https:\/\//, "")}`);
  if (pkg.permissions?.members === "read") out.push("See the names and pictures of people in this canvas, not their e-mail");
  return out;
}

function About({ pkg, host, onClose, onReload }: { pkg: BlockPackage; host: string; onClose(): void; onReload(): void }) {
  const can = canDo(pkg);
  return (
    <Modal onClose={onClose} label={`About ${pkg.title}`}>
      <ModalHead title={pkg.title} sub={`${pkg.publisher ? `by ${pkg.publisher} · ` : ""}${pkg.type} ${pkg.version}`} onClose={onClose} />
      <div className="mbd oc-ext-about">
        <p>Added to {host} by your organisation. It runs apart from the canvas: it can’t read the rest of the page, your sign-in or other blocks.</p>
        {can.length ? (
          <>
            <h3>This block can</h3>
            <ul>
              {can.map((c) => (
                <li key={c}>
                  <Ic name="check" size={16} />
                  {c}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>This block can’t reach the internet or see who is here.</p>
        )}
        <h3>It can’t</h3>
        <ul>
          <li>
            <Ic name="x" size={16} />
            Upload files, open pop-ups or leave this page
          </li>
        </ul>
      </div>
      <div className="mft">
        <button className="btn" onClick={onReload}>
          <Ic name="rotate-ccw" size={16} />
          Reload block
        </button>
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function Status({ tone, icon, title, text, children }: { tone: "red" | "gray" | "blue"; icon: string; title: string; text: string; children?: ReactNode }) {
  return (
    <div className={`oc-ext-status tone-${tone}`} role={tone === "red" ? "alert" : "status"}>
      <Ic name={icon} size={18} />
      <div className="oc-ext-st">
        <b>{title}</b>
        <span>{text}</span>
      </div>
      {children}
    </div>
  );
}

export default function Chrome({ node, editor, getPos, selected, updateAttributes }: ReactNodeViewProps) {
  const b = useBridge();
  const { compact } = useShell();
  const a = node.attrs as ExtAttrs;
  const pkg = installedBlock(a.type);
  const status = statusOf(a, pkg);
  const title = blockTitle(a);
  const host = b.session?.host?.name || "this app";
  const editable = editor.isEditable && b.env.role === "edit";
  const role: "edit" | "comment" | "view" = editable ? "edit" : b.env.role === "comment" ? "comment" : "view";
  const id = a.blockId ?? "";

  const slot = useRef<HTMLDivElement>(null);
  const frame = useRef<BlockFrame | null>(null);
  const [state, setState] = useState<FrameState | null>(null);
  const [height, setHeight] = useState<number>(Number(a.fallback?.height) || 0);
  const [about, setAbout] = useState(false);
  const [peek, setPeek] = useState<HTMLElement | null>(null);
  const [run, setRun] = useState(0);
  const [slow, setSlow] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [, tick] = useState(0);

  // Latest node and data for the frame's reads; the frame lives across renders.
  const live = useRef({ a, pkg, migrated: null as { attrs: Obj; data: Obj } | null, height });
  live.current.a = a;
  live.current.pkg = pkg;
  live.current.height = height;

  const runnable = !!pkg?.frame && (status === "current" || status === "older");

  const read = useCallback(() => {
    const { a, pkg, migrated } = live.current;
    const data = readExtData(b.doc, a.dataId) as Obj;
    if (migrated) return { attrs: migrated.attrs, data: migrated.data } as { attrs: never; data: never };
    if (pkg && statusOf(a, pkg) === "older" && typeof pkg.migrations !== "string") {
      const cur = currentOf(a, data, pkg);
      if (cur) return { attrs: cur.attrs, data: cur.data } as { attrs: never; data: never };
    }
    return { attrs: (a.attrs ?? {}) as never, data: data as never };
  }, [b.doc]);

  /** Writes attrs (and, after a migration, every migrated data field) at the package version,
   *  with the fallback the readers without the package see. */
  const commit = useCallback(
    (attrs: Obj | null, dataFields: Obj | null) => {
      const { a, pkg } = live.current;
      if (!pkg) return;
      const cur = read() as unknown as { attrs: Obj; data: Obj };
      const older = statusOf(a, pkg) === "older";
      let dataId = a.dataId;
      const writesData = !!dataFields || (older && Object.keys(cur.data).length > 0);
      if (writesData && !dataId) dataId = newDataId();
      if (writesData && dataId) writeExtData(b.doc, dataId, { ...(older ? cur.data : {}), ...(dataFields ?? {}) }, "ext-block");
      const nextAttrs = attrs ?? cur.attrs;
      const data = { ...cur.data, ...(dataFields ?? {}) };
      const fb = deriveFallback(pkg, nextAttrs, data);
      updateAttributes({
        attrs: nextAttrs,
        v: pkg.v,
        dataId: dataId ?? null,
        fallback: { ...(a.fallback ?? {}), ...(fb ?? {}), title: pkg.title, height: live.current.height || null },
      });
      live.current.migrated = null;
    },
    [b.doc, read, updateAttributes],
  );

  // Start (or restart) the frame.
  useEffect(() => {
    const el = slot.current;
    if (!runnable || !el || !pkg) return;
    const lock = crashLoop(id || a.type);
    if (lock.locked) {
      setState({ s: "crashed", why: "error" });
      setLockedUntil(lock.until);
      return;
    }
    setSlow(false);
    const slowT = window.setTimeout(() => setSlow(true), 2000);
    const f = new BlockFrame(el, pkg, {
      read: () => read() as never,
      role: () => role,
      migrate: () => {
        const { a, pkg } = live.current;
        return pkg && statusOf(a, pkg) === "older" && typeof pkg.migrations === "string" ? { from: Number(a.v) || 1, to: pkg.v } : null;
      },
      writeAttrs: (attrs) => commit(attrs, null),
      writeData: (fields) => commit(null, fields),
      migrated: (attrs, data) => {
        live.current.migrated = { attrs, data };
      },
      state: (s) => {
        setState(s);
        if (s.s === "crashed") {
          noteCrash(id || a.type);
          const lock = crashLoop(id || a.type);
          setLockedUntil(lock.locked ? lock.until : 0);
        }
        if (s.s === "ready" && id && focusOnReady.delete(id)) f.focus();
      },
      resize: (h) => setHeight(h),
      focusOut: (dir) => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        const c = editor.chain().focus();
        if (dir === "escape") c.setNodeSelection(pos).run();
        else if (dir === "next") c.setTextSelection(Math.min(pos + node.nodeSize, editor.state.doc.content.size)).run();
        else c.setTextSelection(Math.max(0, pos - 1)).run();
      },
      openLink: (url) => b.linkClick(url),
      members: () => b.env.users.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar ?? null })),
      theme: () => readTheme(el.closest(".oc-root") ?? document.documentElement),
    }, `${pkg.title} block`);
    frame.current = f;
    const unfocus = id ? registerFocus(id, () => f.focus()) : () => undefined;
    return () => {
      window.clearTimeout(slowT);
      unfocus();
      f.destroy();
      frame.current = null;
    };
    // The frame restarts on reload, a role change, or the package arriving or leaving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnable, pkg?.frame, run, role]);

  // Document changes reach the running block (attrs here, data through the ext root).
  useEffect(() => {
    frame.current?.update();
  }, [node]);
  useEffect(() => {
    const root = b.doc.getMap("ext");
    const f = () => frame.current?.update();
    root.observeDeep(f);
    return () => root.unobserveDeep(f);
  }, [b.doc]);
  // Theme changes (light/dark) are sent as new tokens.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const f = () => frame.current?.theme();
    mq?.addEventListener?.("change", f);
    const mo = new MutationObserver(f);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq?.removeEventListener?.("change", f);
      mo.disconnect();
    };
  }, []);
  // Block menu: About this block, Reload block.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current?.closest(".oc-ext");
    const f = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === "about") setAbout(true);
      if (what === "reload") reload();
    };
    el?.addEventListener(EXT_ACTION, f);
    return () => el?.removeEventListener(EXT_ACTION, f);
  });
  // "Try again later" counts down.
  useEffect(() => {
    if (!lockedUntil) return;
    const t = window.setTimeout(() => (setLockedUntil(0), tick((x) => x + 1)), Math.max(0, lockedUntil - Date.now()));
    return () => window.clearTimeout(t);
  }, [lockedUntil]);

  const reload = () => {
    if (crashLoop(id || a.type).locked) return;
    setState(null);
    setRun((r) => r + 1);
  };

  // Comments on the whole block (decision 5): a count marker; the block is never told.
  const threads = useThreads(b.doc);
  const mine = useMemo(() => threads.filter((t) => t.block && t.block === id && !t.resolved), [threads, id]);

  // Hover for 600 ms shows the source (1b); click or Enter opens About.
  const hover = useRef<number>(0);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const onBadgeEnter = () => {
    window.clearTimeout(hover.current);
    hover.current = window.setTimeout(() => setPeek(badgeRef.current), 600);
  };
  const onBadgeLeave = () => window.clearTimeout(hover.current);

  const saved = a.fallback?.markdown || a.fallback?.text || "";
  const frameState = !runnable ? null : state?.s ?? "loading";
  const badge = (
    <button
      ref={badgeRef}
      className={"oc-ext-badge" + (frameState === "ready" || frameState === "loading" ? "" : " shown")}
      aria-label={`${title} block${pkg?.publisher ? ` by ${pkg.publisher}` : ""}. About this block`}
      onClick={() => (pkg ? setAbout(true) : undefined)}
      onMouseEnter={pkg ? onBadgeEnter : undefined}
      onMouseLeave={onBadgeLeave}
      onFocus={pkg ? onBadgeEnter : undefined}
      onBlur={onBadgeLeave}
      disabled={!pkg}
    >
      <Ic name="puzzle" size={14} />
      <span>{title}</span>
      {pkg?.publisher && !compact ? <span className="pub">· {pkg.publisher}</span> : null}
    </button>
  );
  const marker = mine.length ? (
    <button className="oc-ext-cmt" aria-label={`${mine.length} comment${mine.length === 1 ? "" : "s"} on this block`} onClick={() => b.openThread(mine[0].id)}>
      <Ic name="message-square" size={14} />
      {mine.length}
    </button>
  ) : null;

  let body: ReactNode;
  if (!runnable || state?.s === "crashed" || state?.s === "migrate-failed") {
    const kind = state?.s === "crashed" ? "crashed" : state?.s === "migrate-failed" ? "migrate" : status === "newer" ? "newer" : "missing";
    const locked = kind === "crashed" && lockedUntil > Date.now();
    body = (
      <div className={`oc-ext-frame oc-ext-fb ${kind}`}>
        {kind === "crashed" ? (
          <Status tone="red" icon="triangle-alert" title="This block stopped working" text={`The ${title} block hit an error and was stopped. The rest of the canvas is fine. Below is the last saved copy.`}>
            <button className="btn" onClick={reload} disabled={locked}>
              <Ic name="rotate-ccw" size={16} />
              {locked ? "Try again later" : "Reload block"}
            </button>
          </Status>
        ) : kind === "newer" ? (
          <Status
            tone="blue"
            icon="info"
            title="Updated by a newer version"
            text={`Someone edited this with ${title} ${Number(a.v) || 1}.0. This editor has ${title} ${pkg?.version ?? ""}, so it’s read only here until ${host} updates it. Nothing is lost.`}
          />
        ) : kind === "migrate" ? (
          <Status
            tone="blue"
            icon="info"
            title="This block couldn’t update its saved data"
            text={`It was saved by an older version of ${title}, and the update didn’t pass the block’s checks. It’s read only here; nothing is lost.`}
          />
        ) : (
          <Status
            tone="gray"
            icon="puzzle"
            title={`${title} isn’t available here`}
            text={`This canvas has a${/^[aeiou]/i.test(title) ? "n" : ""} ${title} block (${a.type}) that ${host} hasn’t turned on. Its data is kept. Below is the saved copy, read only.`}
          />
        )}
        <div className="oc-ext-saved">
          <div className="oc-ext-savedh">{kind === "crashed" ? "Last saved copy" : "Saved copy · read only"}</div>
          {saved ? <SavedCopy md={saved} /> : <p className="oc-ext-none">No saved copy yet.</p>}
        </div>
      </div>
    );
  } else {
    const loading = state?.s !== "ready";
    body = (
      <div className={"oc-ext-frame oc-ext-run" + (loading ? " oc-ext-loading" : "")} aria-busy={loading || undefined} style={{ height: Math.max(loading ? 48 : 24, height || (loading ? 72 : 24)) }}>
        {loading ? (
          <div className="oc-ext-sk" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {loading && slow ? <div className="oc-ext-slow">Loading {title}</div> : null}
        <div className="oc-ext-slot" ref={slot} />
      </div>
    );
  }

  return (
    <div className={"oc-ext-chrome" + (selected ? " sel" : "") + (role !== "edit" ? " ro" : "")} ref={wrapRef} contentEditable={false}>
      {body}
      <div className="oc-ext-top">
        {marker}
        {badge}
      </div>
      {peek && pkg && !about ? (
        <Popover anchor={peek} onClose={() => setPeek(null)} title={`About ${pkg.title}`} minWidth={260} autoFocus={false}>
          <div className="oc-ext-peek" onMouseLeave={() => setPeek(null)}>
            <div className="oc-ext-peekh">
              <ExtIcon pkg={pkg} />
              <div>
                <b>{pkg.title}</b>
                <span>{pkg.publisher ? `by ${pkg.publisher} · ` : ""}{pkg.type} {pkg.version}</span>
              </div>
            </div>
            <p>Added by your organisation.</p>
            {canDo(pkg).length ? (
              <ul>
                {canDo(pkg).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <p>This block can’t reach the internet or see who is here.</p>
            )}
            <button className="linkbtn" onClick={() => (setPeek(null), setAbout(true))}>
              More about this block
            </button>
          </div>
        </Popover>
      ) : null}
      {about && pkg ? (
        <About
          pkg={pkg}
          host={host}
          onClose={() => setAbout(false)}
          onReload={() => {
            setAbout(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
