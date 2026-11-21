import { useState } from "react";
import type { Role } from "@opencanvas/ui";
import { Ic } from "../icons";
import type { Peer } from "../lib/presence";
import { rel, useTick, type Meta } from "../lib/meta";
import { Avatar, Popover, useShell, type Anchor } from "./overlay";
import { readableOn } from "../lib/color";
import type { ExportFormat } from "../lib/exports";

export type SaveState =
  | { kind: "connecting" }
  | { kind: "saved"; at: number | null; version?: string }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "error"; message?: string; retryInMs?: number }
  | { kind: "offline" }
  | { kind: "reconnecting" }
  | { kind: "readonly" }
  /** Conflict or session closed: nothing is being saved from this tab any more. */
  | { kind: "paused" };

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
  onGallery(): void;
  onFollow(p: Peer): void;
  onComments(): void;
  onWide(): void;
  onExport(fmt: ExportFormat): void;
  onHistory(): void;
  onRetry(): void;
  onShortcuts(): void;
}) {
  const { compact } = useShell();
  const [pop, setPop] = useState<{ kind: "status" | "more" | "people"; anchor: Anchor } | null>(null);
  const open = (kind: "status" | "more" | "people") => (e: React.MouseEvent) =>
    setPop(pop?.kind === kind ? null : { kind, anchor: e.currentTarget as HTMLElement });
  const close = () => setPop(null);
  const { meta, save } = props;
  const visible = compact ? props.peers.slice(0, 2) : props.peers.slice(0, 6);
  const extra = props.peers.length - visible.length;

  return (
    <div className="top">
      {props.role === "edit" ? (
        <button className="ib" onClick={props.onGallery} title="New canvas from a template" aria-label="Templates">
          <Ic name="layout-template" />
        </button>
      ) : null}
      <div className="crumbs">
        <span className="cparent">{props.parent}</span>
        <span className="sep">/</span>
        <span className={`ctile tone-${meta.tone}`}>
          <Ic name={meta.icon} size={14} />
        </span>
        <span className="cname">{meta.title || "Untitled"}</span>
      </div>
      <StatusButton save={save} hostName={props.hostName} onClick={open("status")} />
      <div className="avs" aria-label="People here">
        {visible.map((p) => (
          <button
            key={p.id}
            className={"av" + (props.following === p.id ? " following" : "")}
            style={{ background: p.color, color: readableOn(p.color) }}
            title={p.me ? `${p.name} (you)` : p.role === "view" ? `${p.name} · viewing` : props.following === p.id ? `Following ${p.name} · click to stop` : `${p.name} · click to follow`}
            aria-label={peerLabel(p, props.following === p.id)}
            aria-pressed={p.me ? undefined : props.following === p.id}
            onClick={() => !p.me && props.onFollow(p)}
          >
            {p.avatar ? <img src={p.avatar} alt="" /> : <span aria-hidden="true">{initials(p.name)}</span>}
            {p.typing && !p.me ? <span className="dot" /> : null}
            {p.role === "view" ? (
              <span className="eye">
                <Ic name="eye" size={9} />
              </span>
            ) : null}
          </button>
        ))}
        {extra > 0 ? (
          <button className="av more" onClick={open("people")} aria-label={`${extra} more people here`} title="Everyone here">
            <span aria-hidden="true">+{extra}</span>
          </button>
        ) : null}
      </div>
      <button
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
      </button>
      <button className="ib" onClick={open("more")} title="More" aria-label="More options">
        <Ic name="ellipsis" />
      </button>

      {pop?.kind === "status" ? <StatusPopover anchor={pop.anchor} save={save} hostName={props.hostName} onClose={close} onHistory={props.onHistory} onRetry={props.onRetry} /> : null}
      {pop?.kind === "people" ? (
        <Popover anchor={pop.anchor} onClose={close} title="People here" alignRight>
          {props.peers.map((p) => (
            <button key={p.id} className="mi" onClick={() => (close(), !p.me && props.onFollow(p))}>
              <Avatar name={p.name} color={p.color} avatar={p.avatar} />
              <span className="ml">
                <b>
                  {p.name}
                  {p.me ? " (you)" : ""}
                </b>
                <span>{p.role === "view" ? "Viewing" : p.typing ? "Typing" : p.role === "comment" ? "Commenting" : "Editing"}</span>
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
      {pop?.kind === "more" ? (
        <Popover anchor={pop.anchor} onClose={close} title="Canvas" alignRight minWidth={240}>
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
          <button className="mi" onClick={() => (close(), props.onHistory())}>
            <Ic name="history" />
            Version history in {props.hostName}
            <span className="chk" style={{ color: "var(--fg-3)" }}>
              <Ic name="external-link" size={12} />
            </span>
          </button>
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
    case "paused":
      return { cls: "warn", icon: "circle-pause", label: "Autosave paused" };
    case "saved":
      return { cls: "ok", icon: "circle-check", label: "Saved" };
  }
}

function StatusButton({ save, hostName, onClick }: { save: SaveState; hostName: string; onClick(e: React.MouseEvent): void }) {
  const l = statusLook(save);
  const title = l.label + (save.kind === "saved" ? ` to ${hostName}` : "");
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

function StatusPopover({ anchor, save, hostName, onClose, onHistory, onRetry }: { anchor: Anchor; save: SaveState; hostName: string; onClose(): void; onHistory(): void; onRetry(): void }) {
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
            <b style={{ fontWeight: 600, fontSize: 13.5 }}>{ok ? "Autosave is on" : save.kind === "readonly" ? "View only" : paused ? "Autosave paused" : "Saving paused"}</b>
            <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5 }}>{msg}</p>
            {save.kind === "saved" && save.version ? (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fg-3)", fontFamily: "var(--mono)" }}>Version {save.version}</p>
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
      <button className="mi" onClick={() => (onClose(), onHistory())}>
        <Ic name="history" />
        Version history in {hostName}
        <span className="chk" style={{ color: "var(--fg-3)" }}>
          <Ic name="external-link" size={12} />
        </span>
      </button>
    </Popover>
  );
}
