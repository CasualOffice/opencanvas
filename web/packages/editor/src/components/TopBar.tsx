// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { lazy, Suspense, useEffect, useRef, useState } from "react";

const LONG_PRESS_MS = 450;
import { nameWithDetail, type Role } from "@opencanvas/ui";
import { peopleRef } from "../lib/people";
import { Ic } from "../icons";
import type { Peer } from "../lib/presence";
import type { Meta } from "../lib/meta";
import { useShell, type Anchor } from "./overlay";
import { readableOn } from "../lib/color";
import { isMac } from "../lib/keys";
import type { ExportFormat } from "../lib/exports";
import { useStore } from "../lib/store";
import { offlineLook, offlineView } from "../offline/status";

// OFF-06: the offline popover is off the first paint.
const OfflinePopover = lazy(() => import("../offline/ui").then((m) => ({ default: m.OfflinePopover })));
// WEB-08 budget: the menus load when one opens.
const TopMenus = lazy(() => import("./TopMenus"));

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
  | { kind: "temporary" }
  /** BRD-14: the `#demo` canvas lives in this tab only; nothing is ever saved. */
  | { kind: "demo" };

export interface TopBarProps {
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
  /** AUTO-06: "Automations" with the number of rules; absent without `[host.automation]`. */
  onAutomations?: () => void;
  /** AUTO-06 frame 5d: a host without automation shows a quiet line when the canvas has rules. */
  automationsHere?: number;
  /** OFF-06 (frames 2a, 2d, 3b): offline copies, when the host enables them. */
  offline?: { onToggle(on: boolean): void; onList(): void; onTryNow(): void };
}

export function TopBar(props: TopBarProps) {
  const { compact } = useShell();
  // Fetched right after first paint, so a menu opens at once.
  useEffect(() => {
    const t = window.setTimeout(() => void import("./TopMenus").catch(() => undefined), 0);
    return () => window.clearTimeout(t);
  }, []);
  const pressed = useRef<{ id: number; fired: boolean } | null>(null);
  const [pop, setPop] = useState<{ kind: "status" | "more" | "people" | "download"; anchor: Anchor } | null>(null);
  const open = (kind: "status" | "more" | "people" | "download") => (e: React.MouseEvent) =>
    setPop(pop?.kind === kind ? null : { kind, anchor: e.currentTarget as HTMLElement });
  const close = () => setPop(null);
  const { meta, save } = props;
  const ov = useStore(offlineView);
  // 3b: what needs the server stays in the menu, greyed, with the reason.
  const away = ov.net !== "online";
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
      {pop && !(pop.kind === "status" && offlineLook(ov)) ? (
        <Suspense fallback={null}>
          <TopMenus kind={pop.kind} anchor={pop.anchor} close={close} bar={props} shown={shown} />
        </Suspense>
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
    case "demo":
      return { cls: "", icon: "clock", label: "Demo · not saved" };
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

