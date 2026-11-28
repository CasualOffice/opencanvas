// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The top bar's popovers (saving status, everyone here, download, the Canvas menu): loaded when
// one opens (WEB-08 budget), not with the first screen.
import { Ic } from "../icons";
import type { Peer } from "../lib/presence";
import { rel, useTick } from "../lib/meta";
import { Avatar, Popover, useShell, type Anchor } from "./overlay";
import { isMac } from "../lib/keys";
import { useStore } from "../lib/store";
import { keepLine, offlineLook, offlineView } from "../offline/status";
import { HISTORY_KEY, type SaveState, type TopBarProps } from "./TopBar";

export default function TopMenus({ kind, anchor, close, bar, shown }: { kind: "status" | "more" | "people" | "download"; anchor: Anchor; close(): void; bar: TopBarProps; shown(p: Peer): string }) {
  const { compact } = useShell();
  const ov = useStore(offlineView);
  const away = ov.net !== "online";
  const needsNet = (
    <span className="ml">
      <span>Needs a connection</span>
    </span>
  );
  return (
    <>
        {kind === "status" && !offlineLook(ov) ? <StatusPopover anchor={anchor} save={bar.save} hostName={bar.hostName} onClose={close} onHistory={bar.onHistory} onRetry={bar.onRetry} /> : null}
        {kind === "people" ? (
          <Popover anchor={anchor} onClose={close} title="People here" alignRight>
            {bar.peers.map((p) => (
              <button key={p.id} className="mi" onClick={() => (close(), !p.me && bar.onFollow(p))}>
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
        {kind === "download" ? (
          <Popover anchor={anchor} onClose={close} title="Download a copy" alignRight minWidth={240} kind="menu">
            {bar.canExport ? (
              <>
                <button className="mi" role="menuitem" onClick={() => (close(), bar.onExport("pdf"))}>
                  <Ic name="printer" />
                  <span className="ml"><b>PDF</b><span>to read or print</span></span>
                </button>
                <button className="mi" role="menuitem" onClick={() => (close(), bar.onExport("docx"))}>
                  <Ic name="file-type" />
                  <span className="ml"><b>Word</b><span>to keep editing</span></span>
                </button>
                <button className="mi" role="menuitem" onClick={() => (close(), bar.onExport("md"))}>
                  <Ic name="file-text" />
                  <span className="ml"><b>Markdown</b><span>plain text</span></span>
                </button>
              </>
            ) : null}
            {bar.canDownload ? (
              <button className="mi" role="menuitem" onClick={() => (close(), bar.onExport("ocanvas"))}>
                <Ic name="pen-tool" />
                <span className="ml"><b>.ocanvas</b><span>to reopen it later</span></span>
              </button>
            ) : null}
          </Popover>
        ) : null}
        {kind === "more" ? (
          <Popover anchor={anchor} onClose={close} title="Canvas" alignRight minWidth={240}>
            {bar.onFind ? (
              <button className="mi" onClick={() => (close(), bar.onFind!())}>
                <Ic name="search" />
                Find in canvas
                {!compact ? <span className="mk">{isMac ? "⌘F" : "Ctrl+F"}</span> : null}
              </button>
            ) : null}
            {bar.onSearchAll ? (
              <button className="mi" disabled={away} onClick={() => (close(), bar.onSearchAll!())}>
                <Ic name="file-search" />
                Search all canvases
                {away ? needsNet : !compact ? <span className="mk">{isMac ? "⇧⌘F" : "Ctrl+Shift+F"}</span> : null}
              </button>
            ) : null}
            {bar.onLinkedFrom ? (
              <button className="mi" disabled={away} onClick={() => (close(), bar.onLinkedFrom!())}>
                <Ic name="link" />
                Linked from
              </button>
            ) : null}
            {bar.onGraph ? (
              <button className="mi" disabled={away} onClick={() => (close(), bar.onGraph!())}>
                <Ic name="graph" />
                Graph
              </button>
            ) : null}
            {bar.onAutomations ? (
              <button className="mi" onClick={() => (close(), bar.onAutomations!())}>
                <Ic name="zap" />
                Automations
                {bar.automationsHere ? <span className="mk">{bar.automationsHere}</span> : null}
              </button>
            ) : bar.automationsHere ? (
              <div className="mi mi-quiet" role="note">
                <Ic name="zap" />
                {bar.automationsHere} {bar.automationsHere === 1 ? "automation" : "automations"} (not run here)
              </div>
            ) : null}
            {bar.onFind || bar.onSearchAll || bar.onLinkedFrom || bar.onAutomations || bar.automationsHere ? <div className="msep" /> : null}
            {bar.onHistory ? (
              <>
                <button className="mi" disabled={away} onClick={() => (close(), bar.onHistory!())}>
                  <Ic name="history" />
                  Version history
                  {away ? needsNet : !compact ? <span className="mk">{HISTORY_KEY}</span> : null}
                </button>
                {bar.onNameVersion ? (
                  <button className="mi" onClick={() => (close(), bar.onNameVersion!())}>
                    <Ic name="tag" />
                    Name this version
                  </button>
                ) : null}
                <div className="msep" />
              </>
            ) : null}
            {bar.canExport || bar.canDownload ? (
              <>
                <div className="mh">Export</div>
                {bar.canExport ? (
                  <>
                    <button className="mi" onClick={() => (close(), bar.onExport("md"))}>
                      <Ic name="file-text" />
                      Markdown<span className="mk">.md</span>
                    </button>
                    <button className="mi" onClick={() => (close(), bar.onExport("html"))}>
                      <Ic name="code-xml" />
                      Web page<span className="mk">.html</span>
                    </button>
                    <button className="mi" onClick={() => (close(), bar.onExport("docx"))}>
                      <Ic name="file-type" />
                      Word<span className="mk">.docx</span>
                    </button>
                    <button className="mi" onClick={() => (close(), bar.onExport("pdf"))} title="Downloads a PDF, or opens the print dialog when the server can't render one">
                      <Ic name="printer" />
                      PDF<span className="mk">.pdf</span>
                    </button>
                  </>
                ) : null}
                {bar.canDownload ? (
                  <button className="mi" onClick={() => (close(), bar.onExport("ocanvas"))}>
                    <Ic name="pen-tool" />
                    OpenCanvas file<span className="mk">.ocanvas</span>
                  </button>
                ) : null}
                {bar.canExport ? (
                  <button className="mi" onClick={() => (close(), bar.onExport("json"))}>
                    <Ic name="file-down" />
                    JSON<span className="mk">.json</span>
                  </button>
                ) : null}
                <div className="msep" />
              </>
            ) : null}
            {bar.offline && ov.enabled ? (
              <>
                {(() => {
                  const k = keepLine(ov, bar.hostName, compact);
                  return (
                    <button
                      className="mi off-keep"
                      role="menuitemcheckbox"
                      aria-checked={k.on}
                      disabled={k.disabled}
                      onClick={() => (close(), bar.offline!.onToggle(!k.on))}
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
                <button className="mi" onClick={() => (close(), bar.offline!.onList())}>
                  <Ic name="file-text" />
                  Offline canvases on this device
                </button>
                <div className="msep" />
              </>
            ) : null}
            {bar.onImportInto ? (
              <button className="mi" onClick={() => (close(), bar.onImportInto!())}>
                <Ic name="upload" />
                Import…
              </button>
            ) : null}
            {!compact ? (
              <button className="mi" onClick={() => (close(), bar.onWide())}>
                <Ic name="move-horizontal" />
                Full width
                {bar.wide ? (
                  <span className="chk">
                    <Ic name="check" size={14} />
                  </span>
                ) : null}
              </button>
            ) : null}
            {!compact ? (
              <button className="mi" onClick={() => (close(), bar.onShortcuts())}>
                <Ic name="keyboard" />
                Keyboard shortcuts
                <span className="mk">?</span>
              </button>
            ) : null}
          </Popover>
        ) : null}
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
          : save.kind === "demo"
            ? "This demo runs in this tab only. Nothing is saved: a reload starts it again."
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
            <b style={{ fontWeight: 600, fontSize: ".8438rem" }}>{ok ? "Autosave is on" : save.kind === "readonly" ? "View only" : save.kind === "demo" ? "Demo canvas" : paused ? "Autosave paused" : "Saving paused"}</b>
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
