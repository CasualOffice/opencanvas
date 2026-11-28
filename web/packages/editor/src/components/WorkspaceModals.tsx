// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The workspace's modals (replace the canvas, canvas changed outside, canvas closed) and the
// database "Automate" menu. Off the first screen (WEB-08 budget); App fetches this module
// right after first paint, so each shows at once when needed.
import { Ic } from "../icons";
import { isMac } from "../lib/keys";
import { postToHost } from "../lib/host";
import type { TemporaryWording } from "../lib/wording";
import { Modal, ModalHead, Popover, type Anchor } from "./overlay";

export function ReplaceConfirm({ team, onCancel, onReplace }: { team: boolean; onCancel(): void; onReplace(): void }) {
  return (
    <Modal onClose={onCancel} label="Replace canvas">
      <ModalHead
        title="Replace this canvas?"
        sub={team ? "Everyone here sees the change right away. You can undo it from the message that follows." : `Everyone here sees the change right away. You can undo it with ${isMac ? "⌘Z" : "Ctrl+Z"}.`}
        icon="layout-template"
        tone="amber"
      />
      <div className="mft" style={{ paddingTop: 18 }}>
        <button className="btn ghost" data-autofocus onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={onReplace}>
          Replace content
        </button>
      </div>
    </Modal>
  );
}

export function ConflictModal(p: { policy: "copy" | "reload" | null; url?: string; hostName: string; copyName: string; onKeep(): void; onOpenCopy(): void }) {
  return (
    <Modal onClose={p.onKeep} label="Canvas changed">
      <ModalHead title={`This canvas changed in ${p.hostName}`} sub="Someone replaced the file from outside this session." icon="triangle-alert" tone="amber" />
      <div className="mbd">
        <div className="callout" style={{ margin: 0 }} data-tone="green">
          <span className="cic tone-green">
            <Ic name="copy" />
          </span>
          <div style={{ fontSize: ".8438rem", lineHeight: 1.55 }}>
            {p.policy === "copy" ? (
              <>
                Your edits are safe. They were saved as <b>“{p.copyName}”</b> in {p.hostName}. This canvas is read-only now.
              </>
            ) : (
              <>Your edits up to now are kept in this session. Reload to continue from the version in {p.hostName}.</>
            )}
          </div>
        </div>
      </div>
      <div className="mft">
        <button className="btn ghost" onClick={p.onKeep}>
          Keep reading
        </button>
        {p.policy === "copy" && p.url ? (
          <button className="btn primary" onClick={p.onOpenCopy}>
            Open the copy
          </button>
        ) : (
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        )}
      </div>
    </Modal>
  );
}

export function ClosedModal({ closed, temporary, words, hostName }: { closed: { kind: "revoked" | "host" | "other"; reason: string }; temporary: boolean; words: TemporaryWording; hostName: string }) {
  return (
    <Modal onClose={() => undefined} dismissable={false} label="Canvas closed">
      {closed.kind === "revoked" ? (
        temporary && words.revokedTitle ? (
          <ModalHead title={words.revokedTitle} sub={words.revokedSub ?? ""} icon="lock" tone="gray" />
        ) : (
          <ModalHead title="Your access to this canvas changed" sub={`${hostName} no longer lets you open this canvas. Ask the owner if you need it.`} icon="lock" tone="gray" />
        )
      ) : temporary ? (
        <ModalHead title={words.endedTitle} sub={words.endedSub} icon="trash-2" tone="gray" />
      ) : (
        <ModalHead
          title={`${hostName} closed this canvas`}
          sub={(closed.reason && closed.kind === "other" ? closed.reason.replace(/^./, (c) => c.toUpperCase()) + ". " : "") + "Everything up to now was saved."}
          icon="lock"
          tone="gray"
        />
      )}
      {temporary ? (
        closed.kind !== "revoked" && words.startNew ? (
          <div className="mft" style={{ paddingTop: 18 }}>
            {/* MX S6a: the host opens a fresh canvas (the Matrix widget reloads itself). */}
            <button className="btn primary" onClick={() => postToHost("UI_StartNew", {})}>
              <Ic name="plus" size={15} />
              {words.startNew}
            </button>
          </div>
        ) : null
      ) : (
        <div className="mft" style={{ paddingTop: 18 }}>
          <button className="btn primary" onClick={() => postToHost("UI_Close", {})}>
            Back to {hostName}
          </button>
        </div>
      )}
    </Modal>
  );
}

/** AUTO-06: a database's "Automate" menu: its rules, new rules from a trigger, the panel. */
export function AutomateMenu({ anchor, dbId, rules, onClose, onOpen }: { anchor: Anchor; dbId: string; rules: { id: string; name: string; on: boolean }[]; onClose(): void; onOpen(): void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} title="Automate" minWidth={260}>
      {rules.map((r) => (
        <button key={r.id} className="mi" onClick={onOpen}>
          <Ic name="zap" />
          {r.name}
          <span className="mk">{r.on ? "On" : "Off"}</span>
        </button>
      ))}
      {rules.length ? <div className="msep" /> : null}
      {([["row.added", "When a row is added…"], ["field.changed", "When a field changes…"], ["date.reached", "On a date in this database…"]] as const).map(([k, label]) => (
        <button
          key={k}
          className="mi"
          onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent("oc:automate", { detail: { trigger: { kind: k, database: dbId } } }));
          }}
        >
          <Ic name="plus" />
          {label}
        </button>
      ))}
      <div className="msep" />
      <button className="mi" onClick={onOpen}>
        <Ic name="zap" />
        Open Automations
      </button>
    </Popover>
  );
}
