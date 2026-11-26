// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { lazy, Suspense, useRef, useState } from "react";

const LONG_PRESS_MS = 450;
import { nameWithDetail, type Role } from "@opencanvas/ui";
import { peopleRef } from "../lib/people";
import { Ic } from "../icons";
import type { Peer } from "../lib/presence";
import { rel, useTick, type Meta } from "../lib/meta";
import { Avatar, Popover, useShell, type Anchor } from "./overlay";
import { readableOn } from "../lib/color";
import { isMac } from "../lib/keys";
import type { ExportFormat } from "../lib/exports";
import { useStore } from "../lib/store";
import { keepLine, offlineLook, offlineView } from "../offline/status";

// OFF-06: the offline popover is off the first paint.
const OfflinePopover = lazy(() => import("../offline/ui").then((m) => ({ default: m.OfflinePopover })));

/** VH-01d frame 1a: the shortcut shown next to "Version history". */
export const HISTORY_KEY = isMac ? "⌥⌘H" : "Ctrl+Alt+H";

export type SaveState =
  | { kind: "connecting" }
  | { kind: "saved"; at: number | null; version?: string }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "error"; message?: string; retryInMs?: number }
  | { kind: "offline" }
  | { kind: "reconnecting" }
  | { kind: "readonly" }
  /** docs/23 PERM-07: access ended; read only until it is renewed. */
  | { kind: "ended" }
  /** Conflict or session closed: nothing is being saved from this tab any more. */
  | { kind: "paused" }
  /** ADR-043: a temporary canvas; nothing is saved, it is deleted when the room closes. */
  | { kind: "temporary" };

export function TopBar(props: {
  meta: Meta;
  parent: string;
  hostName: string;
  role: Role;
  save: SaveState;
  peers: Peer[];
  following: string | null;
  openThreads: number;
  commentsOpen: boolean;
  wide: boolean;
  canExport: boolean;
  canDownload: boolean;
  /** ADR-043, prototype 5: a temporary canvas gets a "Temporary" label and a one-click Download. */
  temporary?: boolean;
  /** ADR-049: tooltip of the "Temporary" pill, in the host's wording. */
  temporaryTitle?: string;
  /** Click toggles following; a long press (touch) always starts it. */
  onFollow(p: Peer, start?: boolean): void;
  /** Absent: comments are off for this host (EDP-01), no button. */
  onComments?: () => void;
  onWide(): void;
  /** FC-10: "Import…" (only when the host's import flag is on for this person). */
  onImportInto?: () => void;
  onExport(fmt: ExportFormat): void;
  /** VH-01d frame 1a: "Version history ⌥⌘H"; absent when this person may not see history (7b). */
  onHistory?: () => void;
  /** "Name this version": edit access, a host that lists versions, the commitMessage perm. */
  onNameVersion?: () => void;
  onRetry(): void;
  onShortcuts(): void;
  /** Shown only when the assistant is on for this person (docs/24 §10.2). */
  onAssistant?: () => void;
  /** SRCH-01: "Find in canvas ⌘F". */
  onFind?: () => void;
  /** SRCH-04: "Search all canvases ⌘⇧F"; absent (hidden, not disabled) without the host's callback (frame 2e). */
  onSearchAll?: () => void;
  /** OFF-06 (frames 2a, 2d, 3b): offline copies, when the host enables them. */
  offline?: { onToggle(on: boolean): void; onList(): void; onTryNow(): void };
}) {
  const { compact } = useShell();
  const pressed = useRef<{ id: number; fired: boolean } | null>(null);
  const [pop, setPop] = useState<{ kind: "status" | "more" | "people" | "download"; anchor: Anchor } | null>(null);
  const open = (kind: "status" | "more" | "people" | "download") => (e: React.MouseEvent) =>
    setPop(pop?.kind === kind ? null : { kind, anchor: e.currentTarget as HTMLElement });
  const close = () => setPop(null);
  const { meta, save } = props;
  const ov = useStore(offlineView);
  // 3b: what needs the server stays in the menu, greyed, with the reason.
  const away = ov.net !== "online";
  const needsNet = (
    <span className="ml">
      <span>Needs a connection</span>
    </span>
  );
  const visible = compact ? props.peers.slice(0, 2) : props.peers.slice(0, 6);
  const extra = props.peers.length - visible.length;
  // docs/21: shared names carry their second line; initials get a subscript on collision.
  const people = peopleRef.current;
  const dupes = people?.dupes() ?? new Set<string>();
  const shown = (p: Peer) => nameWithDetail(p, dupes);

  return (
    <div className="top">
      <div className="crumbs">
        {props.parent ? (
          <>
            <span className="cparent">{props.parent}</span>
            <span className="sep">/</span>
          </>
        ) : null}
        <span className={`ctile tone-${meta.tone}`}>
          <Ic name={meta.icon} size={14} />
        </span>
        <span className="cname">{meta.title || "Untitled"}</span>
        {props.temporary ? (
          <span className="temp-pill" title={props.temporaryTitle}>
            <Ic name="clock" size={13} />
            Temporary
          </span>
        ) : null}
      </div>
      <StatusButton save={save} hostName={props.hostName} onClick={open("status")} offline={offlineLook(ov)} />
      <div className="avs" aria-label="People here">
        {visible.map((p) =>
          p.agent ? (
            <button
              key={p.id}
              className="av ai-av"
              title={`Assistant, working for ${p.agent.forName?.split(" ")[0] ?? "someone here"}`}
              aria-label={`Assistant, working for ${p.agent.forName ?? "someone here"}. Show where`}
              onClick={() => props.onFollow(p)}
            >
              <Ic name="sparkles" size={14} />
            </button>
          ) : (
          <button
            key={p.id}
            className={"av" + (props.following === p.id ? " following" : "")}
            style={{ background: p.color, color: readableOn(p.color) }}
            title={p.me ? `${shown(p)} (you)` : p.role === "view" ? `${shown(p)} · viewing` : props.following === p.id ? `Following ${shown(p)} · click to stop` : `${shown(p)} · click or hold to follow`}
            aria-label={peerLabel({ ...p, name: shown(p) }, props.following === p.id)}
            aria-pressed={p.me ? undefined : props.following === p.id}
            onClick={() => {
              if (p.me) return;
              // The click that ends a long press must not stop what the press started.
              if (pressed.current?.fired) return void (pressed.current = null);
              props.onFollow(p);
            }}
            onPointerDown={(e) => {
              if (p.me || e.button !== 0) return;
              const id = window.setTimeout(() => {
                if (!pressed.current) return;
                pressed.current.fired = true;
                navigator.vibrate?.(10);
                props.onFollow(p, true);
              }, LONG_PRESS_MS);
              pressed.current = { id, fired: false };
            }}
            onPointerUp={() => pressed.current && !pressed.current.fired && (window.clearTimeout(pressed.current.id), (pressed.current = null))}
            onPointerLeave={() => pressed.current && !pressed.current.fired && (window.clearTimeout(pressed.current.id), (pressed.current = null))}
            onPointerCancel={() => pressed.current && (window.clearTimeout(pressed.current.id), (pressed.current = null))}
            onContextMenu={(e) => !p.me && e.preventDefault()}
          >
            {p.avatar ? (
              <img src={p.avatar} alt="" />
            ) : (
              <span aria-hidden="true">{people?.initialsOf(p.id, p.name) ?? initials(p.name)}</span>
            )}
            {p.typing && !p.me ? <span className="dot" /> : null}
            {p.role === "view" ? (
              <span className="eye">
                <Ic name="eye" size={9} />
              </span>
            ) : null}
          </button>
          ),
        )}
        {extra > 0 ? (
          <button className="av more" onClick={open("people")} aria-label={`${extra} more people here`} title="Everyone here">
            <span aria-hidden="true">+{extra}</span>
          </button>
        ) : null}
      </div>
      {props.onAssistant ? (
        compact ? (
          <button className="ib" disabled={away} onClick={props.onAssistant} title={away ? "Assistant · needs a connection" : "Assistant"} aria-label={away ? "Assistant, needs a connection" : "Assistant"} aria-keyshortcuts={isMac ? "Meta+J" : "Control+J"}>
            <Ic name="sparkles" style={{ color: "var(--ai)" }} />
          </button>
        ) : (
          <button className="btn out ai-hbtn" disabled={away} onClick={props.onAssistant} title={away ? "Needs a connection" : `Ask about this canvas (${isMac ? "⌘J" : "Ctrl+J"})`} aria-keyshortcuts={isMac ? "Meta+J" : "Control+J"}>
            <Ic name="sparkles" style={{ color: "var(--ai)" }} />
            Assistant
          </button>
        )
      ) : null}
      {props.onComments ? <button
        className="ib rel"
        onClick={props.onComments}
        title="Comments"
        aria-label={props.openThreads ? `Comments, ${props.openThreads} open` : "Comments"}
        aria-pressed={props.commentsOpen}
      >
        <Ic name="message-square" />
        {props.openThreads ? (
          <span className="badge" aria-hidden="true">
            {props.openThreads}
          </span>
        ) : null}
      </button> : null}
      {props.temporary && (props.canExport || props.canDownload) ? (
        <button className={compact ? "ib" : "btn primary sm temp-dl"} onClick={open("download")} aria-haspopup="menu" aria-expanded={pop?.kind === "download"} title="Download a copy to keep" aria-label={compact ? "Download a copy" : undefined}>
          <Ic name="download" />
          {compact ? null : "Download"}
        </button>
      ) : null}
      <button className="ib" onClick={open("more")} title="More" aria-label="More options">
        <Ic name="ellipsis" />
      </button>

      {pop?.kind === "status" && offlineLook(ov) ? (
        <Suspense fallback={null}>
          <OfflinePopover anchor={pop.anchor} hostName={props.hostName} onClose={close} onTryNow={() => (close(), props.offline?.onTryNow())} onKeep={() => props.offline?.onToggle(true)} />
        </Suspense>
      ) : null}
      {pop?.kind === "status" && !offlineLook(ov) ? <StatusPopover anchor={pop.anchor} save={save} hostName={props.hostName} onClose={close} onHistory={props.onHistory} onRetry={props.onRetry} /> : null}
      {pop?.kind === "people" ? (
        <Popover anchor={pop.anchor} onClose={close} title="People here" alignRight>
          {props.peers.map((p) => (
            <button key={p.id} className="mi" onClick={() => (close(), !p.me && props.onFollow(p))}>
              <Avatar name={p.name} color={p.color} avatar={p.avatar} />
              <span className="ml">
                <b>
                  {shown(p)}
                  {p.me ? " (you)" : ""}
                </b>
                <span>{p.role === "view" ? "Viewing" : p.typing ? "Typing" : p.role === "comment" ? "Commenting" : "Editing"}</span>
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
      {pop?.kind === "download" ? (
        <Popover anchor={pop.anchor} onClose={close} title="Download a copy" alignRight minWidth={240} kind="menu">
          {props.canExport ? (
            <>
              <button className="mi" role="menuitem" onClick={() => (close(), props.onExport("pdf"))}>
                <Ic name="printer" />
                <span className="ml"><b>PDF</b><span>to read or print</span></span>
              </button>
              <button className="mi" role="menuitem" onClick={() => (close(), props.onExport("docx"))}>
                <Ic name="file-type" />
                <span className="ml"><b>Word</b><span>to keep editing</span></span>
              </button>
              <button className="mi" role="menuitem" onClick={() => (close(), props.onExport("md"))}>
                <Ic name="file-text" />
                <span className="ml"><b>Markdown</b><span>plain text</span></span>
              </button>
            </>
          ) : null}
          {props.canDownload ? (
            <button className="mi" role="menuitem" onClick={() => (close(), props.onExport("ocanvas"))}>
              <Ic name="pen-tool" />
              <span className="ml"><b>.ocanvas</b><span>to reopen it later</span></span>
            </button>
          ) : null}
        </Popover>
      ) : null}
      {pop?.kind === "more" ? (
        <Popover anchor={pop.anchor} onClose={close} title="Canvas" alignRight minWidth={240}>
          {props.onFind ? (
            <button className="mi" onClick={() => (close(), props.onFind!())}>
              <Ic name="search" />
              Find in canvas
              {!compact ? <span className="mk">{isMac ? "⌘F" : "Ctrl+F"}</span> : null}
            </button>
          ) : null}
          {props.onSearchAll ? (
            <button className="mi" disabled={away} onClick={() => (close(), props.onSearchAll!())}>
              <Ic name="file-search" />
              Search all canvases
              {away ? needsNet : !compact ? <span className="mk">{isMac ? "⇧⌘F" : "Ctrl+Shift+F"}</span> : null}
            </button>
          ) : null}
          {props.onFind || props.onSearchAll ? <div className="msep" /> : null}
          {props.onHistory ? (
            <>
              <button className="mi" disabled={away} onClick={() => (close(), props.onHistory!())}>
                <Ic name="history" />
                Version history
                {away ? needsNet : !compact ? <span className="mk">{HISTORY_KEY}</span> : null}
              </button>
              {props.onNameVersion ? (
                <button className="mi" onClick={() => (close(), props.onNameVersion!())}>
                  <Ic name="tag" />
                  Name this version
                </button>
              ) : null}
              <div className="msep" />
            </>
          ) : null}
          {props.canExport || props.canDownload ? (
            <>
              <div className="mh">Export</div>
              {props.canExport ? (
                <>
                  <button className="mi" onClick={() => (close(), props.onExport("md"))}>
                    <Ic name="file-text" />
                    Markdown<span className="mk">.md</span>
                  </button>
                  <button className="mi" onClick={() => (close(), props.onExport("html"))}>
                    <Ic name="code-xml" />
                    Web page<span className="mk">.html</span>
                  </button>
                  <button className="mi" onClick={() => (close(), props.onExport("docx"))}>
                    <Ic name="file-type" />
                    Word<span className="mk">.docx</span>
                  </button>
                  <button className="mi" onClick={() => (close(), props.onExport("pdf"))} title="Downloads a PDF, or opens the print dialog when the server can't render one">
                    <Ic name="printer" />
                    PDF<span className="mk">.pdf</span>
                  </button>
                </>
              ) : null}
              {props.canDownload ? (
                <button className="mi" onClick={() => (close(), props.onExport("ocanvas"))}>
                  <Ic name="pen-tool" />
                  OpenCanvas file<span className="mk">.ocanvas</span>
                </button>
              ) : null}
              {props.canExport ? (
                <button className="mi" onClick={() => (close(), props.onExport("json"))}>
                  <Ic name="file-down" />
                  JSON<span className="mk">.json</span>
                </button>
              ) : null}
              <div className="msep" />
            </>
          ) : null}
          {props.offline && ov.enabled ? (
            <>
              {(() => {
                const k = keepLine(ov, props.hostName, compact);
                return (
                  <button
                    className="mi off-keep"
                    role="menuitemcheckbox"
                    aria-checked={k.on}
                    disabled={k.disabled}
                    onClick={() => (close(), props.offline!.onToggle(!k.on))}
                  >
                    <Ic name="cloud-off" />
                    <span className="ml">
                      <b>Available offline on this {compact ? "phone" : "device"}</b>
                      <span>{k.sub}</span>
                    </span>
                    <span className={"off-sw" + (k.on ? " on" : "")} aria-hidden="true" />
                  </button>
                );
              })()}
              <button className="mi" onClick={() => (close(), props.offline!.onList())}>
                <Ic name="file-text" />
                Offline canvases on this device
              </button>
              <div className="msep" />
            </>
          ) : null}
          {props.onImportInto ? (
            <button className="mi" onClick={() => (close(), props.onImportInto!())}>
              <Ic name="upload" />
              Import…
            </button>
          ) : null}
          {!compact ? (
            <button className="mi" onClick={() => (close(), props.onWide())}>
              <Ic name="move-horizontal" />
              Full width
              {props.wide ? (
                <span className="chk">
                  <Ic name="check" size={14} />
                </span>
              ) : null}
            </button>
          ) : null}
          {!compact ? (
            <button className="mi" onClick={() => (close(), props.onShortcuts())}>
              <Ic name="keyboard" />
              Keyboard shortcuts
              <span className="mk">?</span>
            </button>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}

/** Accessible name for an avatar: who, what they are doing, and what a click does. */
export function peerLabel(p: Peer, following: boolean): string {
  if (p.me) return `${p.name} (you)`;
  return following ? `Stop following ${p.name}` : `Follow ${p.name}`;
}

function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

function statusLook(save: SaveState): { cls: string; icon: string; label: string } {
  switch (save.kind) {
    case "connecting":
      return { cls: "", icon: "loader-circle", label: "Connecting" };
    case "saving":
      return { cls: "", icon: "loader-circle", label: "Saving" };
    case "unsaved":
      return { cls: "", icon: "clock", label: "Unsaved changes" };
    case "error":
      return { cls: "bad", icon: "triangle-alert", label: "Retrying save" };
    case "offline":
      return { cls: "warn", icon: "cloud-off", label: "Offline · kept here" };
    case "reconnecting":
      return { cls: "warn", icon: "loader-circle", label: "Reconnecting" };
    case "readonly":
      return { cls: "", icon: "eye", label: "View only" };
    case "ended":
      return { cls: "", icon: "lock", label: "Read only" };
    case "paused":
      return { cls: "warn", icon: "circle-pause", label: "Autosave paused" };
    case "saved":
      return { cls: "ok", icon: "circle-check", label: "Saved" };
    case "temporary":
      return { cls: "", icon: "clock", label: "Not saved · temporary" };
  }
}

function StatusButton({ save, hostName, onClick, offline }: { save: SaveState; hostName: string; onClick(e: React.MouseEvent): void; offline: { cls: string; icon: string; label: string } | null }) {
  const l = offline ?? statusLook(save);
  const title = l.label + (!offline && save.kind === "saved" ? ` to ${hostName}` : "");
  return (
    <>
      <button className={"status " + l.cls} onClick={onClick} title={title} aria-label={title} aria-haspopup="dialog">
        <Ic name={l.icon} size={16} className={l.icon === "loader-circle" ? "spin" : ""} />
        <span className="lbl" aria-hidden="true">
          {l.label}
        </span>
      </button>
      {/* Announce only states that need attention; "Saving / Saved" every few seconds would be noise. */}
      <span className="sr-only" role="status" aria-live="polite">
        {l.cls === "bad" || l.cls === "warn" ? l.label : ""}
      </span>
    </>
  );
}

function StatusPopover({ anchor, save, hostName, onClose, onHistory, onRetry }: { anchor: Anchor; save: SaveState; hostName: string; onClose(): void; onHistory?: () => void; onRetry(): void }) {
  useTick(10000);
  const ok = save.kind === "saved" || save.kind === "saving" || save.kind === "unsaved" || save.kind === "connecting";
  const paused = save.kind === "paused";
  const bad = save.kind === "error";
  const msg =
    save.kind === "offline"
      ? "You're offline. Changes are kept in this tab and sync when you're back."
      : save.kind === "reconnecting"
        ? "Reconnecting to the canvas server. Keep working; nothing is lost."
        : save.kind === "error"
          ? `${hostName} didn't accept the last save. We retry every ${Math.round((save.retryInMs ?? 10000) / 1000)} seconds. Nothing is lost.`
          : save.kind === "ended"
            ? `Your access ended. Reconnect to keep editing; your changes are kept on this page.`
          : save.kind === "readonly"
            ? `You can view this canvas. ${hostName} saves the changes others make.`
            : paused
              ? `This tab no longer saves to ${hostName}. Everything saved before is safe there.`
            : save.kind === "saved" && save.at
              ? `All changes saved to ${hostName} ${rel(save.at)}. There's nothing to save by hand.`
              : `Every change saves to ${hostName} on its own. There's nothing to save by hand.`;
  return (
    <Popover anchor={anchor} onClose={onClose} title="Saving" alignRight>
      <div className="pad" style={{ maxWidth: 300 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span className={`cic tone-${ok ? "green" : bad ? "red" : "amber"}`}>
            <Ic name={ok ? "circle-check" : bad ? "triangle-alert" : save.kind === "readonly" ? "eye" : "cloud-off"} />
          </span>
          <div>
            <b style={{ fontWeight: 600, fontSize: ".8438rem" }}>{ok ? "Autosave is on" : save.kind === "readonly" ? "View only" : paused ? "Autosave paused" : "Saving paused"}</b>
            <p style={{ margin: "2px 0 0", fontSize: ".8125rem", color: "var(--fg-2)", lineHeight: 1.5 }}>{msg}</p>
            {save.kind === "saved" && save.version ? (
              <p style={{ margin: ".375rem 0 0", fontSize: ".75rem", color: "var(--fg-3)", fontFamily: "var(--mono)" }}>Version {save.version}</p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="msep" />
      {bad ? (
        <button className="mi" onClick={() => (onClose(), onRetry())}>
          <Ic name="rotate-ccw" />
          Retry now
        </button>
      ) : null}
      {onHistory ? (
        <button className="mi" onClick={() => (onClose(), onHistory())}>
          <Ic name="history" />
          Version history
        </button>
      ) : null}
    </Popover>
  );
}
