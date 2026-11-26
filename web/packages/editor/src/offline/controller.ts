// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The offline controller (OFF-02..06, ADR-063/064, docs/34 §3), loaded only for hosts with
// `[host.offline] enabled`. It keeps the canvas on the device when the person (or the host's
// `auto_recent`) chose so, watches the connection, and runs every reconnect as a fresh launch
// through the host: the host's current answer decides (edit: replay in frames; view: hold the
// unsent changes; none or a raised generation: delete the copy) before anything is sent. The
// offline grant is only ever read here, on the device.
import * as Y from "yjs";
import { postToHost } from "../lib/host";
import { bridge } from "../lib/bridge";
import { offlineUploads } from "../lib/uploads";
import { createStore } from "../lib/store";
import type { Collab, Session } from "../lib/session";
import { Copy, Device, type CopyMeta, type IndexEntry } from "./copy";
import { open, openJson, seal, sealJson, verifyGrant, type GrantClaims, type Sealed } from "./crypto";
import { idbKv, type Kv } from "./kv";
import { analyze, track, type MergeItem, type Touched } from "./merge";
import { FROM_DEVICE, needsCheckpoint } from "./pending";
import { DEFAULT_LIMITS, offlineView, patchView, reconnectToken } from "./status";
import { unsentBlocks } from "./marks";

const MB = 1024 * 1024;
/** How long the host has to answer `Token_Expiring {reason: "reconnect"}`. */
export const TOKEN_WAIT_MS = 8_000;
const PROBE_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

export interface MergeSummary {
  changes: number;
  items: MergeItem[];
  refused: boolean;
  checkpoint: string | null;
  /** The device's document before the merge (for "Restore my text"). */
  before: Uint8Array;
}

/** Dialogs and panels of the offline UI (offline/ui.tsx). */
export interface OfflineUi {
  dialog: null | "explain" | "list" | "room" | "removeAll";
  room?: { usedMb: number; needMb: number; browser?: boolean };
  merge: MergeSummary | null;
  /** A held copy's document (5a: "Download my version"). */
  heldDoc: Uint8Array | null;
}

export const offlineUi = createStore<OfflineUi>({ dialog: null, merge: null, heldDoc: null });

export interface Ctx {
  session: Session;
  collab: Collab;
  hostName: string;
  /** Start the Workspace over (a fresh doc from the server). */
  reboot(): void;
  /** The session now runs on `ticket` (a fresh launch). */
  setTicket(ticket: string, exp: number | null): void;
  /** Who a Yjs client id belongs to, when they are here. */
  nameOfClient(client: number): string | null;
  toast(text: string, opts?: { icon?: string; action?: { label: string; run(): void }; ms?: number }): void;
}

let kv: Kv | null = null;
const store = () => (kv ??= idbKv());
/** Tests inject an in-memory store. */
export function useKv(k: Kv) {
  kv = k;
}

const sessionPrefs = (s: Session) => {
  const { ticket: _t, ...rest } = s;
  return rest;
};

/** The person's copies are gone at the host's word: every copy for this host and person. */
async function wipe(dev: Device) {
  const r = await dev.removeAll();
  return r;
}

export class Controller {
  readonly dev: Device;
  readonly copy: Copy;
  private meta: CopyMeta | null = null;
  private touched: (Touched & { stop(): void }) | null = null;
  private offs: (() => void)[] = [];
  private probe: number | undefined;
  private probeStep = 0;
  private reconnecting = false;
  private writeChain: Promise<unknown> = Promise.resolve();
  private metaTimer: number | undefined;
  private expTimer: number | undefined;
  private destroyed = false;

  constructor(readonly ctx: Ctx) {
    const s = ctx.session;
    this.dev = new Device(store(), s.host.id, s.user.id);
    this.copy = this.dev.copy(s.file.id);
  }

  private get s() {
    return this.ctx.session;
  }
  private get doc() {
    return this.ctx.collab.doc;
  }
  private get pending() {
    return this.ctx.collab.pending;
  }

  /** Online start (the session answer is fresh): revocation, grant renewal, auto_recent. */
  async start(openedOffline = false) {
    const o = this.s.offline;
    patchView({
      enabled: !!o?.enabled,
      allowed: !!o?.allowed,
      reason: o?.reason,
      maxDays: o?.maxDays ?? 7,
      limits: o?.limits ?? DEFAULT_LIMITS,
      openedOffline,
    });
    this.offs.push(this.ctx.collab.onConn((c) => this.onConn(c)));
    this.offs.push(this.pending.version.subscribe(() => this.onPending()));
    const onOnline = () => this.kick();
    window.addEventListener("online", onOnline);
    this.offs.push(() => window.removeEventListener("online", onOnline));
    this.offs.push(this.ctx.collab.onControl((c) => c.t === "saved" && this.onSaved()));
    if (openedOffline) {
      this.meta = await this.copy.meta();
      this.attach();
      offlineUploads.queue = (f) => this.queueUpload(f);
      void this.countUploads();
      this.touched = track(this.doc, (o) => o !== this.ctx.collab.provider && o !== FROM_DEVICE);
      patchView({ kept: true, net: "offline", offlineSince: Date.now() });
      this.onPending();
      this.watchExpiry();
      this.schedule();
      return;
    }
    if (!o?.enabled) {
      // The host turned offline copies off: none may stay.
      if ((await this.dev.list()).length) await wipe(this.dev);
      return;
    }
    // OFF-03: the editor code for opening without a network (no content in it).
    void navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    const list = await this.dev.list();
    // Host-wide revoke (ADR-064): a device with a lower generation deletes every copy.
    if (list.some((e) => e.gen < (o.gen ?? 0))) {
      await wipe(this.dev);
      patchView({ kept: false });
      return;
    }
    this.meta = await this.copy.meta();
    if (this.meta && !o.allowed) {
      // Not allowed any more for this launch (a shared session): this copy goes.
      await this.copy.remove();
      this.meta = null;
    }
    if (this.meta?.held) {
      offlineUi.set((u) => ({ ...u, heldDoc: null }));
      const n = (await this.copy.pending()).length;
      patchView({ held: n, kept: true });
      void this.loadHeld();
      return;
    }
    if (this.meta) {
      // Unsent changes from a session closed while offline: a fresh launch already happened
      // (this one), so they go out now, in frames.
      const left = await this.copy.pending();
      if (left.length) {
        if (this.s.role === "view") {
          await this.hold(left.length, left.map((e) => e.update));
          return;
        }
        Y.applyUpdate(this.doc, Y.mergeUpdates(left.map((e) => e.update)), FROM_DEVICE);
        this.pending.restore(left);
      }
      await this.renew();
      await this.copy.snapshot(this.doc);
      this.attach();
      patchView({ kept: true, auto: this.meta.auto });
      this.remember(true);
      if (left.length) void this.replay(this.s.ticket, left.length, left[0].at);
    } else if (o.allowed && (o.autoRecent ?? 0) > 0) {
      await this.keep(true, true).catch(() => undefined);
    }
    this.watchExpiry();
  }

  destroy() {
    this.destroyed = true;
    offlineUploads.queue = null;
    this.offs.forEach((f) => f());
    this.touched?.stop();
    window.clearTimeout(this.probe);
    window.clearTimeout(this.metaTimer);
    window.clearTimeout(this.expTimer);
    if (reconnectToken.take) reconnectToken.take = null;
  }

  // ---------- keeping a canvas (2a, 2b, 2e) ----------

  /** Turns "Available offline on this device" on or off. On: checks the limits first. */
  async keep(on: boolean, auto = false): Promise<"ok" | "room" | "browser"> {
    const o = this.s.offline;
    if (!on) {
      await this.copy.remove();
      this.meta = null;
      this.detach();
      patchView({ kept: false, auto: false });
      this.remember(false);
      return "ok";
    }
    if (!o?.allowed || !o.grant || !o.key) return "browser";
    const limits = o.limits ?? DEFAULT_LIMITS;
    const need = Y.encodeStateAsUpdate(this.doc).length;
    const use = await this.dev.usage();
    if (auto) {
      // auto_recent: evict the oldest automatic copies past N (never one with unsent changes).
      const autos = (await this.dev.list()).filter((e) => e.auto && !e.pending).sort((a, b) => a.keptAt - b.keptAt);
      while (autos.length >= (o.autoRecent ?? 0)) await this.dev.copy(autos.shift()!.file).remove();
    }
    if (use.count >= limits.maxCanvases || use.bytes + need > limits.maxMb * MB) {
      offlineUi.set((u) => ({ ...u, dialog: auto ? null : "room", room: { usedMb: use.bytes / MB, needMb: need / MB } }));
      return "room";
    }
    try {
      const claims = await verifyGrant(o.grant, o.key);
      if (!claims) return "browser";
      void navigator.storage?.persist?.().catch(() => false);
      this.meta = this.metaFrom(claims, o.grant, o.key, need, auto);
      await this.copy.snapshot(this.doc);
      await this.copy.setMeta(this.meta);
      await this.saveSession();
    } catch {
      offlineUi.set((u) => ({ ...u, dialog: auto ? null : "room", room: { usedMb: use.bytes / MB, needMb: need / MB, browser: true } }));
      return "browser";
    }
    this.attach();
    this.remember(true);
    patchView({ kept: true, auto, validUntil: this.meta.exp * 1000, lastSent: Date.now() });
    return "ok";
  }

  private metaFrom(c: GrantClaims, grant: string, jwk: JsonWebKey, bytes: number, auto: boolean): CopyMeta {
    return {
      file: this.s.file.id,
      title: this.title(),
      bytes,
      pending: this.pending.size,
      lastSent: Date.now(),
      exp: c.exp,
      gen: c.gen,
      role: c.role,
      keptAt: Date.now(),
      auto,
      grant,
      jwk,
    };
  }

  /** Which kept canvas this tab's ticket opened (ids only), for a reload without a network. */
  private remember(on: boolean) {
    try {
      if (on) localStorage.setItem("oc:offline-launch", JSON.stringify({ t: this.s.ticket, h: this.s.host.id, u: this.s.user.id, f: this.s.file.id }));
      else localStorage.removeItem("oc:offline-launch");
    } catch {
      /* storage blocked: a reload offline shows the error screen */
    }
  }

  private title() {
    const t = this.doc.getMap("meta").get("title");
    return typeof t === "string" && t ? t : this.s.file.name;
  }

  /** The session answer, sealed, so the canvas can open without a launch (OFF-03). */
  private async saveSession() {
    const k = await this.dev.key(true);
    await this.dev.kv.put(this.copy.db, "custom", await sealJson(k!, sessionPrefs(this.s)), "session");
  }

  /** A fresh grant from this session's answer extends the copy (`valid until`). */
  private async renew() {
    const o = this.s.offline;
    if (!this.meta || !o?.grant || !o.key) return;
    const c = await verifyGrant(o.grant, o.key);
    if (!c) return;
    this.meta = { ...this.meta, grant: o.grant, jwk: o.key, exp: c.exp, gen: c.gen, role: c.role, title: this.title() };
    await this.copy.setMeta(this.meta);
    await this.saveSession();
    patchView({ validUntil: c.exp * 1000 });
  }

  private onDocUpdate = (u: Uint8Array, origin: unknown) => {
    if (origin === FROM_DEVICE || !this.meta) return;
    this.writeChain = this.writeChain.then(() => this.copy.append(u, this.doc)).then((n) => {
      if (this.meta) this.meta.bytes += typeof n === "number" ? n : 0;
    }, () => undefined);
    this.scheduleMeta();
  };

  private attach() {
    this.doc.off("update", this.onDocUpdate);
    this.doc.on("update", this.onDocUpdate);
    this.pending.onAdd = (e) => {
      this.writeChain = this.writeChain.then(() => this.copy.addPending(e)).catch(() => undefined);
    };
    this.pending.onConfirm = (upTo) => {
      this.writeChain = this.writeChain.then(() => this.copy.confirm(upTo)).catch(() => undefined);
    };
  }

  private detach() {
    this.doc.off("update", this.onDocUpdate);
    this.pending.onAdd = null;
    this.pending.onConfirm = null;
  }

  private scheduleMeta() {
    if (this.metaTimer !== undefined) return;
    this.metaTimer = window.setTimeout(() => {
      this.metaTimer = undefined;
      if (!this.meta || this.destroyed) return;
      this.meta = { ...this.meta, title: this.title(), pending: this.pending.size };
      this.writeChain = this.writeChain.then(() => this.meta && this.copy.setMeta(this.meta)).catch(() => undefined);
    }, 1500);
  }

  private onSaved() {
    if (!this.meta) return;
    this.meta = { ...this.meta, lastSent: Date.now() };
    patchView({ lastSent: this.meta.lastSent });
    this.scheduleMeta();
  }

  private onPending() {
    const p = this.pending;
    const limit = (this.s.offline?.limits ?? DEFAULT_LIMITS).unsentMb * MB;
    const v = offlineView.get();
    patchView({ pending: p.size, pendingBytes: p.bytes, paused: v.net !== "online" && p.bytes > limit });
    if (v.net !== "online" && this.touched) unsentBlocks.set(new Set(this.touched.blocks));
    if (!p.size && unsentBlocks.get().size) unsentBlocks.set(new Set());
  }

  // ---------- expiry (5c) ----------

  private watchExpiry() {
    window.clearTimeout(this.expTimer);
    const exp = this.meta?.exp;
    if (!exp) return;
    patchView({ validUntil: exp * 1000 });
    const left = exp * 1000 - Date.now();
    const lock = () => offlineView.get().net !== "online" && patchView({ locked: true });
    if (left <= 0) lock();
    else this.expTimer = window.setTimeout(lock, Math.min(left, 2 ** 31 - 1));
  }

  // ---------- connection (1a-1c, 4a) ----------

  private onConn(c: "connecting" | "connected" | "reconnecting" | "offline") {
    if (this.reconnecting) return;
    if (c === "offline" && offlineView.get().net === "online") {
      // Every reconnect is a fresh launch (ADR-064): stop the provider's own retries.
      this.ctx.collab.pause();
      this.touched?.stop();
      const isLocal = (o: unknown) => o !== this.ctx.collab.provider && o !== FROM_DEVICE;
      this.touched = track(this.doc, isLocal);
      patchView({ net: "offline", offlineSince: Date.now() });
      if (this.meta) offlineUploads.queue = (f) => this.queueUpload(f);
      if (this.meta && this.meta.exp * 1000 < Date.now()) patchView({ locked: true });
      this.probeStep = 0;
      this.schedule();
    }
  }

  private schedule() {
    window.clearTimeout(this.probe);
    const ms = PROBE_MS[Math.min(this.probeStep++, PROBE_MS.length - 1)];
    this.probe = window.setTimeout(() => this.kick(), ms);
  }

  /** "Try now" and the `online` event: check the server at once. */
  kick() {
    if (this.reconnecting || this.destroyed || offlineView.get().net === "online") return;
    window.clearTimeout(this.probe);
    void this.tryReconnect();
  }

  private async tryReconnect() {
    let up = false;
    try {
      up = (await fetch("/healthz", { cache: "no-store" })).ok;
    } catch {
      up = false;
    }
    if (!up) return this.schedule();
    this.reconnecting = true;
    patchView({ net: "reconnecting" });
    try {
      const fresh = await this.freshLaunch();
      if (fresh === "retry") {
        patchView({ net: "offline" });
        this.schedule();
        return;
      }
      await this.decide(fresh);
    } catch {
      patchView({ net: "offline" });
      this.schedule();
    } finally {
      this.reconnecting = false;
    }
  }

  /** Asks the host for a fresh launch token (docs/05 §4: `Token_Expiring {reason: "reconnect"}`). */
  private async freshLaunch(): Promise<"retry" | "none" | { ticket: string; session: Session }> {
    const answer = await new Promise<Record<string, unknown> | null>((resolve) => {
      const t = window.setTimeout(() => {
        reconnectToken.take = null;
        resolve(null);
      }, TOKEN_WAIT_MS);
      reconnectToken.take = (v) => {
        window.clearTimeout(t);
        reconnectToken.take = null;
        resolve(v);
      };
      postToHost("Token_Expiring", { inSeconds: 0, reason: "reconnect" });
    });
    if (answer?.access === "none") return "none";
    if (typeof answer?.token === "string" && answer.token) {
      const r = await fetch("/v1/launch", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: answer.token }),
      });
      if (r.status === 403) return "none";
      if (!r.ok) return "retry";
      const { ticket } = (await r.json()) as { ticket: string };
      return this.sessionFor(ticket);
    }
    // A host that doesn't renew: the session still running, re-checked by the server.
    if (this.s.ticket && (!this.s.exp || this.s.exp * 1000 > Date.now())) return this.sessionFor(this.s.ticket);
    return "retry";
  }

  private async sessionFor(ticket: string): Promise<"retry" | { ticket: string; session: Session }> {
    const r = await fetch(`/v1/sessions/${encodeURIComponent(ticket)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return "retry";
    return { ticket, session: (await r.json()) as Session };
  }

  /** The host's current answer decides before anything is sent (ADR-064). */
  private async decide(fresh: "none" | { ticket: string; session: Session }) {
    const count = this.pending.size;
    const o = fresh === "none" ? null : fresh.session.offline;
    const revoked = fresh === "none" || (o && this.meta && (o.gen ?? 0) > this.meta.gen) || (o && !o.enabled && this.meta);
    if (revoked) {
      // 5b: the copy and its unsent changes go before anything is drawn.
      if (fresh === "none") await this.copy.remove();
      else await wipe(this.dev);
      this.meta = null;
      this.detach();
      this.pending.clear();
      patchView({ revoked: { count }, net: "online", kept: false, locked: false, paused: false });
      return;
    }
    const f = fresh as { ticket: string; session: Session };
    Object.assign(this.s, { offline: f.session.offline, perms: f.session.perms, exp: f.session.exp });
    if (f.session.role === "view" && count > 0) {
      // 5a: never sent as suggestions; held for download or discard.
      await this.hold(count, null);
      this.ctx.setTicket(f.ticket, f.session.exp ?? null);
      this.ctx.reboot();
      return;
    }
    this.ctx.setTicket(f.ticket, f.session.exp ?? null);
    if (this.meta) this.remember(true);
    await this.renew();
    // Queued files first, so nobody sees a broken image (4a).
    offlineUploads.queue = null;
    await this.sendUploads();
    patchView({ locked: false });
    const first = this.pending.entries[0]?.at ?? Date.now();
    await this.replay(f.ticket, count, first);
  }

  /** Sends the unsent changes (4a), then looks for what needs attention (4b-4d). */
  private async replay(ticket: string, count: number, since: number) {
    const before = Y.encodeStateAsUpdate(this.doc);
    const touched = this.touched ?? { blocks: new Set<string>(), cells: new Map() };
    const checkpoint = needsCheckpoint(this.pending.entries) ? { changes: count, since } : null;
    patchView({ net: count ? "sending" : "reconnecting", sending: { sent: 0, total: 1 } });
    const res = await this.ctx.collab.resume(ticket, {
      checkpoint,
      onProgress: (sent, total) => patchView({ sending: { sent, total } }),
    });
    await this.ctx.collab.synced;
    // Let the room's answer (SyncStep2) land before comparing.
    await new Promise((r) => window.setTimeout(r, 400));
    this.touched?.stop();
    this.touched = null;
    unsentBlocks.set(new Set());
    patchView({ net: "online", offlineSince: null, sending: undefined, paused: false, lastSent: Date.now(), openedOffline: false });
    this.probeStep = 0;
    if (!count) return;
    const items = analyze(before, this.doc, touched);
    if (items.length || res.refused) {
      offlineUi.set((u) => ({ ...u, merge: { changes: count, items, refused: res.refused, checkpoint: res.checkpoint ?? null, before } }));
    } else {
      this.ctx.toast(`Your ${count} offline change${count === 1 ? " is" : "s are"} saved`, { icon: "circle-check" });
    }
    if (res.refused) this.ctx.reboot();
  }

  // ---------- queued uploads (OFF-05) ----------

  private async countUploads() {
    const l = await this.dev.uploads(this.s.file.id);
    patchView({ uploads: { count: l.length, bytes: l.reduce((n, u) => n + u.size, 0) } });
    return l;
  }

  private async queueUpload(f: File): Promise<{ ref: string; by: string } | null> {
    const lim = this.s.offline?.limits ?? DEFAULT_LIMITS;
    const l = await this.dev.uploads(this.s.file.id);
    const bytes = l.reduce((n, u) => n + u.size, 0);
    if (l.length >= lim.uploadsFiles || bytes + f.size > lim.uploadsMb * MB) {
      this.ctx.toast(`Up to ${lim.uploadsFiles} files and ${lim.uploadsMb} MB can wait to upload. Connect to add more.`, { icon: "triangle-alert" });
      return null;
    }
    const id = crypto.randomUUID();
    await this.dev.queueUpload({ id, file: this.s.file.id, name: f.name, mime: f.type, size: f.size, at: Date.now() }, new Uint8Array(await f.arrayBuffer()));
    await this.countUploads();
    return { ref: "oc-pending:" + id, by: this.s.user.id };
  }

  private async sendUploads() {
    const list = await this.dev.uploads(this.s.file.id);
    let sent = 0;
    for (const u of list) {
      const data = await this.dev.uploadData(u.id);
      if (!data) continue;
      try {
        const up = await bridge.upload(new File([data as BlobPart], u.name, { type: u.mime }), () => undefined);
        rewritePending(this.doc, "oc-pending:" + u.id, up.url);
        await this.dev.dropUpload(u.id);
        patchView({ uploads: { count: list.length, bytes: list.reduce((n, x) => n + x.size, 0), sent: ++sent } });
      } catch {
        /* stays queued for the next reconnect */
      }
    }
    await this.countUploads();
  }

  // ---------- view only on reconnect (5a) ----------

  private async hold(count: number, updates: Uint8Array[] | null) {
    const state = updates ? Y.mergeUpdates([Y.encodeStateAsUpdate(this.doc), ...updates]) : Y.encodeStateAsUpdate(this.doc);
    offlineUi.set((u) => ({ ...u, heldDoc: state }));
    if (this.meta) {
      this.meta = { ...this.meta, held: true, pending: count };
      await this.copy.setMeta(this.meta);
      const k = await this.dev.key(true);
      await this.dev.kv.put(this.copy.db, "custom", await seal(k!, state), "held");
    }
    this.detach();
    this.pending.clear();
    patchView({ held: count, net: "online" });
  }

  private async loadHeld() {
    const k = await this.dev.key();
    const s = k && (await this.dev.kv.get<Sealed>(this.copy.db, "custom", "held"));
    if (!k || !s) return;
    const state = await open(k, s);
    offlineUi.set((u) => ({ ...u, heldDoc: state }));
  }

  /** "Discard": the held changes go; the copy follows the server again. */
  async discardHeld() {
    offlineUi.set((u) => ({ ...u, heldDoc: null }));
    patchView({ held: 0 });
    if (this.meta) {
      await this.dev.kv.del(this.copy.db, "custom", "held");
      await this.copy.clearPending();
      this.meta = { ...this.meta, held: false, pending: 0 };
      await this.copy.snapshot(this.doc);
      await this.copy.setMeta(this.meta);
      this.attach();
    }
  }

  // ---------- the list (2c, 7b, 7c) ----------

  list(): Promise<IndexEntry[]> {
    return this.dev.list();
  }

  async remove(file: string) {
    if (file === this.s.file.id) return void (await this.keep(false));
    await this.dev.copy(file).remove();
  }

  async removeAll() {
    const r = await this.dev.removeAll();
    this.meta = null;
    this.detach();
    patchView({ kept: false, auto: false });
    return r;
  }
}

/** Points every node that waits for `ref` at the uploaded `url`, in one transaction. */
export function rewritePending(doc: Y.Doc, ref: string, url: string) {
  const walk = (n: Y.XmlElement | Y.XmlFragment) => {
    for (const c of n.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      for (const k of ["src", "url"]) {
        if (c.getAttribute(k) === ref) {
          c.setAttribute(k, url);
          c.removeAttribute("pendingBy");
        }
      }
      walk(c);
    }
  };
  doc.transact(() => walk(doc.getXmlFragment("content")));
}

let current: Controller | null = null;
export const controller = () => current;

export async function start(ctx: Ctx, openedOffline = false): Promise<Controller> {
  current?.destroy();
  const c = new Controller(ctx);
  current = c;
  await c.start(openedOffline);
  return c;
}

/** OFF-03: what opening a kept canvas without a launch needs (`#offline=1&h=&u=&f=`). */
export interface OfflineOpen {
  session: Session;
  doc: Y.Doc;
  claims: GrantClaims | null;
  locked: boolean;
  pending: import("./pending").PendingEntry[];
}

export async function openOffline(host: string, user: string, file: string): Promise<OfflineOpen | null> {
  const dev = new Device(store(), host, user);
  const copy = dev.copy(file);
  const meta = await copy.meta();
  if (!meta || meta.held) return null;
  const k = await dev.key();
  const sealed = k && (await dev.kv.get<Sealed>(copy.db, "custom", "session"));
  if (!k || !sealed) return null;
  const prefs = await openJson<Omit<Session, "ticket">>(k, sealed);
  const claims = await verifyGrant(meta.grant, meta.jwk);
  if (!claims || claims.host !== host || claims.sub !== user || claims.file !== file) return null;
  const locked = claims.exp * 1000 <= Date.now();
  const doc = new Y.Doc();
  if (!locked) await copy.loadInto(doc);
  const pending = await copy.pending();
  const session: Session = { ...(prefs as Session), ticket: "", role: claims.role, exp: null, isNew: false };
  return { session, doc, claims, locked, pending };
}
