// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Offline editing UI to the approved prototype (OFF-06, docs/prototypes/v03-approved/offline.html):
// the pill's popover (1b, 1c, 4a, 8a), the first-time explainer (2b, 8c), the list of offline
// canvases (2c, 7b, 7c), "not enough room" (2e), the banners that stop work (5a held, 5c
// locked, 5d paused), "access removed" (5b) and the merge summary (4c, 4d, 8b). Lazy: none of
// it is on the first paint.
import { useEffect, useState } from "react";
import * as Y from "yjs";
import { Ic } from "../icons";
import { Modal, ModalHead, Popover, useShell, type Anchor } from "../components/overlay";
import { toast, useStore } from "../lib/store";
import { controller, offlineUi, type MergeSummary } from "./controller";
import { cellLabel, removeBlock, restoreBlock, useMine, type MergeItem } from "./merge";
import type { IndexEntry } from "./copy";
import { offlineView } from "./status";
import { docToMarkdown } from "./markdown";
import "./offline.css";

const MB = 1024 * 1024;
const mb = (b: number) => (b >= 10 * MB ? Math.round(b / MB) : Math.round((b / MB) * 10) / 10) + " MB";
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const time = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `Today ${t}` : `${day(ms)}, ${t}`;
};
const ago = (ms: number | null) => {
  if (!ms) return "Not sent yet";
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "Sent just now";
  if (m < 60) return `Sent ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `Sent ${h} h ago` : h < 48 ? "Sent yesterday" : `Sent ${day(ms)}`;
};
const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="off-fact">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

/** The pill's popover (desktop) or sheet (phone) while offline, reconnecting or sending. */
export function OfflinePopover({ anchor, hostName, onClose, onTryNow, onKeep }: { anchor: Anchor; hostName: string; onClose(): void; onTryNow(): void; onKeep(): void }) {
  const v = useStore(offlineView);
  const { compact } = useShell();
  const where = compact ? "phone" : "device";
  let title = "You’re offline";
  let body: React.ReactNode;
  if (v.net === "sending" || v.net === "reconnecting") {
    title = "Back online";
    body = (
      <>
        <p>Sending what you did offline. You can keep working.</p>
        <div className="off-facts">
          <Fact k={`Signed in again through ${hostName}`} v={v.net === "sending" ? "Done" : "Waiting"} />
          {v.uploads.count ? <Fact k={`Uploading ${v.uploads.count} file${v.uploads.count === 1 ? "" : "s"}`} v={mb(v.uploads.bytes)} /> : null}
          <Fact k={`Sending ${changes(v.pending)}`} v={v.sending ? `${v.sending.sent} of ${v.sending.total}` : "…"} />
        </div>
      </>
    );
  } else if (v.kept) {
    body = (
      <>
        <p>Keep working. Your changes are saved on this {where} and sent when you’re back online.</p>
        <div className="off-facts">
          <Fact k="Changes not sent yet" v={String(v.pending)} />
          {v.uploads.count ? <Fact k="Waiting to upload" v={`${v.uploads.count} file${v.uploads.count === 1 ? "" : "s"} · ${mb(v.uploads.bytes)}`} /> : null}
          <Fact k="Last sent" v={time(v.lastSent) || "Not yet"} />
          <Fact k="Offline copy valid until" v={day(v.validUntil)} />
        </div>
        {v.pending ? (
          <p className="off-note">
            <span className="off-bar" aria-hidden="true" />A bar at the left marks text that isn’t sent yet.
          </p>
        ) : null}
        <p className="off-note">AI, version history and search across canvases need a connection.</p>
      </>
    );
  } else {
    body = (
      <>
        <p>
          {v.pending ? `Your ${changes(v.pending)} are kept in this tab only.` : "Changes you make are kept in this tab."} Keep it open: they are sent as soon as you’re back online.
        </p>
        <div className="off-facts">
          <Fact k="Offline since" v={time(v.offlineSince)} />
          <Fact k={`Saved on this ${where}`} v="No" />
        </div>
        {v.enabled && v.allowed ? (
          <p className="off-note">
            To keep canvases between visits, turn on{" "}
            <button className="btn link sm" onClick={() => (onClose(), onKeep())}>
              Available offline on this {where}
            </button>{" "}
            in the canvas menu.
          </p>
        ) : null}
      </>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose} title={title} alignRight kind="dialog">
      <div className="pad off-pop" role="group" aria-label={title}>
        <div className="off-pop-h">
          <span className={`cic tone-${v.net === "offline" ? "amber" : "blue"}`}>
            <Ic name={v.net === "offline" ? "cloud-off" : "loader-circle"} className={v.net === "offline" ? "" : "spin"} />
          </span>
          <b>{title}</b>
        </div>
        {body}
        {v.net === "offline" ? (
          <button className="btn sm pri off-try" onClick={onTryNow} data-autofocus>
            <Ic name="rotate-ccw" size={14} />
            {v.kept ? "Try now" : "Try again"}
          </button>
        ) : null}
      </div>
    </Popover>
  );
}

function Explain({ title, days, hostName, onCancel, onKeep }: { title: string; days: number; hostName: string; onCancel(): void; onKeep(): void }) {
  const { compact } = useShell();
  const where = compact ? "phone" : "device";
  return (
    <Modal onClose={onCancel} label={`Keep “${title}” on this ${where}?`}>
      <ModalHead icon="cloud-off" tone="blue" title={`Keep “${title}” on this ${where}?`} sub="You can open and edit it without a connection. Your changes are sent when you’re back online." onClose={onCancel} />
      <div className="mbd off-facts3">
        <p>
          <Ic name="clock" size={16} />
          <span>
            <b>Works offline for {days} days</b> after you were last online. Then it locks until you connect.
          </span>
        </p>
        <p>
          <Ic name="users-round" size={16} />
          <span>
            <b>Anyone who uses this browser as you can read it.</b> Only use this on your own {where}.
          </span>
        </p>
        <p>
          <Ic name="lock" size={16} />
          <span>Signing out of {hostName} removes it from this {where}.</span>
        </p>
      </div>
      <div className="mft">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={onKeep}>
          Keep offline
        </button>
      </div>
    </Modal>
  );
}

function Room({ hostName, title, room, onClose, onManage }: { hostName: string; title: string; room: { usedMb: number; needMb: number; browser?: boolean }; onClose(): void; onManage(): void }) {
  return (
    <Modal onClose={onClose} label="Not enough room on this device">
      <ModalHead icon="triangle-alert" tone="amber" title="Not enough room on this device" onClose={onClose} />
      <div className="mbd">
        <p className="off-p">
          {room.browser
            ? `This browser didn’t allow ${title} to be kept (storage is full, or this is a private window).`
            : `Offline canvases from ${hostName} are using ${Math.round(room.usedMb)} MB of ${offlineView.get().limits.maxMb} MB. ${title} needs about ${Math.max(1, Math.round(room.needMb))} MB.`}
        </p>
        <p className="off-p">Remove a canvas you no longer need offline, then try again.</p>
      </div>
      <div className="mft">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={onManage}>
          Manage offline canvases
        </button>
      </div>
    </Modal>
  );
}

function List({ hostName, me, onClose }: { hostName: string; me: string; onClose(): void }) {
  const v = useStore(offlineView);
  const [items, setItems] = useState<IndexEntry[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const load = () => void controller()?.list().then(setItems, () => setItems([]));
  useEffect(load, []);
  const used = (items ?? []).reduce((n, e) => n + e.bytes, 0);
  const autoN = (items ?? []).filter((e) => e.auto).length;
  const unsent = (items ?? []).filter((e) => e.pending > 0);
  if (confirm)
    return (
      <Modal onClose={() => setConfirm(false)} label="Remove all offline copies from this device?">
        <ModalHead icon="triangle-alert" tone="red" title="Remove all offline copies from this device?" sub={`${items?.length ?? 0} canvases, ${mb(used)}. You can keep them offline again later.`} onClose={() => setConfirm(false)} />
        {unsent.length ? (
          <div className="mbd">
            {unsent.map((e) => (
              <p key={e.file} className="off-p off-warn">
                <Ic name="triangle-alert" size={14} />
                {e.title} has {changes(e.pending)} that haven’t been sent. They will be lost.
              </p>
            ))}
          </div>
        ) : null}
        <div className="mft">
          <button className="btn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              await controller()?.removeAll();
              setConfirm(false);
              onClose();
              toast("Offline copies removed from this device", { icon: "check" });
            }}
          >
            Remove all
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal onClose={onClose} wide label="Offline on this device">
      <ModalHead
        icon="cloud-off"
        tone="blue"
        title="Offline on this device"
        sub={items && items.length ? `${mb(used)} of ${v.limits.maxMb} MB · ${items.length} of ${v.limits.maxCanvases} canvases` : undefined}
        onClose={onClose}
      />
      <div className="mbd">
        {items === null ? null : items.length ? (
          <>
            <p className="off-p off-mut">Only on this browser, for {me} in {hostName}. Signing out removes them.</p>
            <div className="off-list" role="list" aria-label="Canvases">
              {items.map((e) => (
                <div key={e.file} className="off-row" role="listitem">
                  <Ic name="file-text" />
                  <span className="off-row-t">
                    <b>{e.title}</b>
                    <span>
                      {e.path ? `${e.path} · ` : ""}
                      {mb(e.bytes)}
                    </span>
                    <span className={e.pending ? "off-warn" : ""}>
                      {e.pending ? `${changes(e.pending)} not sent` : ago(e.lastSent)} · valid until {day(e.exp * 1000)}
                    </span>
                  </span>
                  <button className="btn sm" onClick={async () => (await controller()?.remove(e.file), load())} aria-label={`Remove ${e.title}`}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
            {autoN ? <p className="off-p off-mut">{hostName} also keeps your most recent canvases offline.</p> : null}
          </>
        ) : (
          <div className="off-empty">
            <Ic name="cloud-off" size={24} />
            <b>No offline canvases yet</b>
            <p>Turn on Available offline on this device in a canvas’s menu to open it without a connection.</p>
            <p className="off-mut">Only canvases you keep, {me.split(" ")[0]}, are listed here.</p>
          </div>
        )}
      </div>
      {items && items.length ? (
        <div className="mft">
          <button className="btn danger line" onClick={() => setConfirm(true)}>
            Remove all offline copies
          </button>
        </div>
      ) : null}
    </Modal>
  );
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function Merge({ m, me, doc, onClose, onHistory, nameOf }: { m: MergeSummary; me: string; doc: Y.Doc; onClose(): void; onHistory?: () => void; nameOf(c: number | null): string }) {
  const [done, setDone] = useState<Record<number, string>>({});
  const open = m.items.filter((_, i) => !done[i]);
  const n = open.length + (m.refused ? 1 : 0);
  const restore = (it: Extract<MergeItem, { kind: "deleted" }>, i: number) => {
    const id = "b_r" + Math.random().toString(36).slice(2, 14);
    if (!restoreBlock(m.before, doc, it, id, me)) return;
    setDone((d) => ({ ...d, [i]: id }));
    toast("Restored as a new block", { icon: "rotate-ccw", action: { label: "Undo", run: () => (removeBlock(doc, id), setDone((d) => ({ ...d, [i]: "" }))) }, ms: 8000 });
  };
  return (
    <Modal onClose={onClose} label={`Back online · ${n} thing${n === 1 ? "" : "s"} to check`}>
      <ModalHead icon="circle-check" tone="green" title={n ? `Back online · ${n} thing${n === 1 ? "" : "s"} to check` : "Back online"} sub={`Your ${m.changes} offline change${m.changes === 1 ? " is" : "s are"} saved.${n ? " Almost everything merged on its own; these need a look." : ""}`} onClose={onClose} />
      <div className="mbd off-merge">
        {m.items.map((it, i) =>
          it.kind === "deleted" ? (
            done[i] ? (
              <section key={i} className="off-card">
                <b>Your text in “{it.title}” was restored</b>
                <p>It is back as a new block where the old one was.</p>
                <button className="btn sm" onClick={() => (removeBlock(doc, done[i]), setDone((d) => ({ ...d, [i]: "" })))}>
                  Undo
                </button>
              </section>
            ) : (
              <section key={i} className="off-card">
                <b>You edited a block that was deleted</b>
                <p>“{it.title}” was removed while you were offline. Your edit to it is not in the canvas:</p>
                <blockquote>{it.text.length > 240 ? "… " + it.text.slice(-240) : it.text}</blockquote>
                <div className="off-acts">
                  <button className="btn sm primary" onClick={() => restore(it, i)}>
                    Restore my text as a new block
                  </button>
                  <button className="btn sm" onClick={() => setDone((d) => ({ ...d, [i]: "dismissed" }))}>
                    Dismiss
                  </button>
                </div>
              </section>
            )
          ) : done[i] ? null : (
            <section key={i} className="off-card">
              <b>You and {nameOf(it.theirsBy)} both changed one {it.fieldName.toLowerCase()}</b>
              <p>
                {it.rowTitle} · {it.fieldName}
              </p>
              <div className="off-vals">
                <span>
                  Kept · {nameOf(it.theirsBy)}
                  <b>{cellLabel(it.theirs) || "Empty"}</b>
                </span>
                <span>
                  Yours · offline
                  <b>{cellLabel(it.mine) || "Empty"}</b>
                </span>
              </div>
              <div className="off-acts">
                <button className="btn sm primary" onClick={() => (useMine(doc, it), setDone((d) => ({ ...d, [i]: "mine" })))}>
                  Use mine
                </button>
                <button className="btn sm" onClick={() => setDone((d) => ({ ...d, [i]: "theirs" }))}>
                  Keep {nameOf(it.theirsBy)}’s
                </button>
              </div>
            </section>
          ),
        )}
        {m.refused ? (
          <section className="off-card">
            <b>Some changes weren’t accepted</b>
            <p>The server refused part of what you did offline (your access or a limit changed). The rest is saved.</p>
          </section>
        ) : null}
        {m.checkpoint ? (
          <p className="off-p off-mut">
            A version “Before {me}’s offline changes” was saved.{" "}
            {onHistory ? (
              <button className="btn link sm" onClick={() => (onClose(), onHistory())}>
                Open version history
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="mft">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/** Everything offline that is not the pill: dialogs, banners, the merge summary. */
export function OfflineRoot(props: {
  hostName: string;
  me: string;
  title: string;
  doc: Y.Doc;
  canDownload: boolean;
  onHistory?: () => void;
  nameOfClient(c: number): string | null;
  onBack(): void;
}) {
  const ui = useStore(offlineUi);
  const v = useStore(offlineView);
  const close = () => offlineUi.set((u) => ({ ...u, dialog: null }));
  const ctl = controller();
  const nameOf = (c: number | null) => (c !== null && props.nameOfClient(c)) || "someone else";
  return (
    <>
      {ui.dialog === "explain" ? (
        <Explain
          title={props.title}
          days={v.maxDays}
          hostName={props.hostName}
          onCancel={close}
          onKeep={async () => {
            close();
            try {
              localStorage.setItem("oc:offline-explained", "1");
            } catch {
              /* asked again next time */
            }
            const r = await ctl?.keep(true);
            if (r === "ok") toast(`“${props.title}” is available offline on this device`, { icon: "check" });
          }}
        />
      ) : null}
      {ui.dialog === "room" && ui.room ? <Room hostName={props.hostName} title={props.title} room={ui.room} onClose={close} onManage={() => offlineUi.set((u) => ({ ...u, dialog: "list" }))} /> : null}
      {ui.dialog === "list" ? <List hostName={props.hostName} me={props.me} onClose={close} /> : null}
      {ui.merge ? <Merge m={ui.merge} me={props.me} doc={props.doc} onClose={() => offlineUi.set((u) => ({ ...u, merge: null }))} onHistory={props.onHistory} nameOf={nameOf} /> : null}
      {v.revoked ? (
        <Modal onClose={() => undefined} dismissable={false} label="You no longer have access to this canvas">
          <ModalHead icon="lock" tone="red" title="You no longer have access to this canvas" />
          <div className="mbd">
            <p className="off-p">
              Your access to {props.title} was removed while you were offline. The offline copy was removed from this device
              {v.revoked.count ? `, with ${changes(v.revoked.count)} you made offline that hadn’t been sent.` : "."}
            </p>
          </div>
          <div className="mft">
            <button className="btn primary" onClick={props.onBack}>
              Back to {props.hostName}
            </button>
          </div>
        </Modal>
      ) : null}
        </>
  );
}

/** The banners that stop work (5a, 5c, 5d), in the Workspace's banner row. */
export function OfflineBanners(p: { hostName: string; title: string; canDownload: boolean }) {
  const v = useStore(offlineView);
  const ui = useStore(offlineUi);
  const { compact } = useShell();
  const out: React.ReactNode[] = [];
  if (v.held)
    out.push(
      <div key="held" role="alert" className="banner warn off-banner">
        <Ic name="eye" />
        <span>
          <strong>You can only view this canvas now.</strong> Your access changed while you were offline, so your {changes(v.held)} weren’t sent. They’re still on this device.
        </span>
        {p.canDownload && ui.heldDoc ? (
          <button
            className="btn sm line"
            onClick={() => {
              const d = new Y.Doc();
              Y.applyUpdate(d, ui.heldDoc!);
              download(`${p.title || "Canvas"} (my offline version).md`, docToMarkdown(d), "text/markdown");
            }}
          >
            Download my version
          </button>
        ) : null}
        <button className="btn sm link" onClick={() => void controller()?.discardHeld()}>
          Discard
        </button>
      </div>,
    );
  if (v.locked)
    out.push(
      <div key="locked" role="alert" className="banner bad off-banner">
        <Ic name="lock" />
        <span>
          This offline copy expired on {day(v.validUntil)}. Connect to {p.hostName} to open it again.
          {v.pending ? ` Your ${changes(v.pending)} not sent yet are kept on this device.` : ""}
        </span>
        <button className={"btn sm" + (compact ? " off-full" : "")} onClick={() => controller()?.kick()}>
          Try again
        </button>
      </div>,
    );
  else if (v.paused)
    out.push(
      <div key="paused" role="alert" className="banner bad off-banner">
        <Ic name="circle-pause" />
        <span>
          <strong>Editing is paused.</strong> {v.limits.unsentMb} MB of changes are waiting on this device, the most one canvas can hold offline. Connect to send them and keep editing.
        </span>
        <button className="btn sm" onClick={() => controller()?.kick()}>
          Try again
        </button>
      </div>,
    );
  return <>{out}</>;
}

/** 5c: the locked copy shows its title only. */
export function LockedCanvas({ title }: { title: string }) {
  return (
    <div className="off-locked" role="region" aria-label="Locked offline copy">
      <Ic name="lock" size={28} />
      <h1>{title}</h1>
      <p>Locked until you’re back online</p>
      <p className="off-mut">Offline copies stop opening {offlineView.get().maxDays} days after you were last online, so a lost or shared device doesn’t keep showing them.</p>
    </div>
  );
}

/** Opens the first-time explainer once per device, then just flips. */
export function toggleKeep(on: boolean) {
  const ctl = controller();
  if (!ctl) return;
  if (!on) return void ctl.keep(false).then(() => toast("Removed from this device", { icon: "check" }));
  let explained = false;
  try {
    explained = localStorage.getItem("oc:offline-explained") === "1";
  } catch {
    /* ask */
  }
  if (!explained) return offlineUi.set((u) => ({ ...u, dialog: "explain" }));
  void ctl.keep(true).then((r) => r === "ok" && toast("Available offline on this device", { icon: "check" }));
}

export const openList = () => offlineUi.set((u) => ({ ...u, dialog: "list" }));
