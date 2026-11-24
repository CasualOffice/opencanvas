// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The editor side of the block sandbox (BSDK-03, docs/27 §3.4, docs/15 §4.3). Lazy: loads only
// when a canvas has an SDK block this editor can run.
//
// One `BlockFrame` per block instance: an `<iframe sandbox="allow-scripts">` (never
// allow-same-origin, allow-top-navigation, allow-popups-to-escape-sandbox or allow-forms)
// on the separate block origin. The frame says "ready" to its parent; the editor checks that the
// message came from this iframe's window with the opaque origin "null" and hands it one end of a
// MessageChannel. Everything after that goes over the port: a typed RPC where the editor owns
// the Y.Doc and applies the block's writes on its behalf, after checking the role, the rate
// limit (60 writes/s) and the package's JSON Schemas. A block that throws, stops answering the
// heartbeat for 5 s or never renders is reported as crashed; the rest of the canvas carries on.
import { Schema } from "./schema";
import type { BlockPackage } from "./model";

export type FrameState =
  | { s: "loading" }
  | { s: "ready" }
  | { s: "crashed"; why: "error" | "hang" | "load" }
  | { s: "migrate-failed"; why: string };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, Json>;

export interface FrameHost {
  /** Current attrs and data (already migrated when the stored version is older). */
  read(): { attrs: Obj; data: Obj };
  /** The role the block runs with ("edit" only when this person may edit). */
  role(): "edit" | "comment" | "view";
  /** Set when the frame must run a script migration first: stored version → package's. */
  migrate(): { from: number; to: number } | null;
  /** Writes checked attrs / data fields (null removes a field). */
  writeAttrs(attrs: Obj): void;
  writeData(fields: Obj): void;
  /** The frame migrated older data (script migrations): it is kept until the first write. */
  migrated(attrs: Obj, data: Obj): void;
  state(s: FrameState): void;
  resize(h: number): void;
  focusOut(dir: "escape" | "next" | "prev"): void;
  openLink(url: string): void;
  members(): { id: string; name: string; avatar?: string | null }[];
  theme(): { scheme: "light" | "dark"; tokens: Record<string, string> };
}

/** Writes per second a block may make (docs/27 §3.4), and the burst. */
export const WRITE_RATE = 60;
const HEARTBEAT_MS = 1000;
const HANG_MS = 5000;
const RENDER_MS = 10_000;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

/** Applies a patch: keys set, `null` removes. */
export function merge(base: Obj, patch: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Token bucket on an injectable clock (tests pin it). */
export class Bucket {
  private tokens: number;
  private at: number;
  constructor(private rate: number, private now: () => number = () => performance.now()) {
    this.tokens = rate;
    this.at = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.rate, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** The checks every write from a block goes through, apart from the transport (tests use it
 *  without a frame). Returns the value to write, or throws a message for the block. */
export class WriteGate {
  private attrs: Schema;
  private data: Schema | null;
  private bucket: Bucket;
  constructor(pkg: Pick<BlockPackage, "attrs" | "data">, now?: () => number) {
    this.attrs = Schema.compile(pkg.attrs ?? { type: "object" });
    this.data = pkg.data ? Schema.compile(pkg.data) : null;
    this.bucket = new Bucket(WRITE_RATE, now);
  }
  private common(role: string) {
    if (role !== "edit") throw new Error("read only: this person can't edit the canvas");
    if (!this.bucket.take()) throw new Error("rate limited: at most 60 writes a second");
  }
  attrsWrite(role: string, current: Obj, patch: unknown): Obj {
    this.common(role);
    if (!isObj(patch)) throw new Error("setAttrs takes an object");
    const next = merge(current, clone(patch));
    const bad = this.attrs.validate(next);
    if (bad.length) throw new Error(`attrs don't match the block's schema: ${bad[0][0] || "/"} ${bad[0][1]}`);
    return next;
  }
  dataWrite(role: string, current: Obj, fields: unknown): Obj {
    this.common(role);
    if (!isObj(fields)) throw new Error("data.set takes an object of fields");
    if (!this.data) throw new Error("this block declares no data");
    const f = clone(fields);
    const next = merge(current, f);
    const bad = this.data.validate(next);
    if (bad.length) throw new Error(`data doesn't match the block's schema: ${bad[0][0] || "/"} ${bad[0][1]}`);
    return f;
  }
}

export class BlockFrame {
  readonly iframe: HTMLIFrameElement;
  private port: MessagePort | null = null;
  private gate: WriteGate;
  private ping = 0;
  private lastPong = 0;
  private timers: number[] = [];
  private rendered = false;
  private dead = false;
  private onWindowMessage = (e: MessageEvent) => this.handshake(e);

  constructor(container: HTMLElement, private pkg: BlockPackage, private host: FrameHost, label: string) {
    this.gate = new WriteGate(pkg);
    const f = document.createElement("iframe");
    // allow-scripts only: an opaque origin, no same-origin access, no top navigation,
    // no popups, no forms (docs/27 §3.4).
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("title", label);
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("loading", "eager");
    f.className = "oc-ext-iframe";
    f.src = pkg.frame ?? "about:blank";
    this.iframe = f;
    window.addEventListener("message", this.onWindowMessage);
    container.append(f);
    this.host.state({ s: "loading" });
    this.timers.push(window.setTimeout(() => !this.rendered && this.crash("load"), RENDER_MS));
  }

  private handshake(e: MessageEvent) {
    if (this.port || e.source !== this.iframe.contentWindow) return;
    // The sandbox has no allow-same-origin, so its origin is opaque.
    if (e.origin !== "null") return;
    const m = e.data as { t?: string } | null;
    if (!m || m.t !== "ready") return;
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.port.onmessage = (ev) => this.onMessage(ev.data);
    this.iframe.contentWindow?.postMessage({ t: "connect" }, "*", [ch.port2]);
    const { attrs, data } = this.host.read();
    const theme = this.host.theme();
    this.iframe.style.colorScheme = theme.scheme;
    this.port.postMessage({
      t: "init", type: this.pkg.type, v: this.pkg.v, attrs, data, role: this.host.role(), theme,
      permissions: this.pkg.permissions ?? { network: [], members: "none" }, migrate: this.host.migrate(),
    });
    this.lastPong = performance.now();
    this.timers.push(
      window.setInterval(() => {
        if (performance.now() - this.lastPong > HANG_MS) return this.crash("hang");
        this.port?.postMessage({ t: "ping", n: ++this.ping });
      }, HEARTBEAT_MS),
    );
  }

  private reply(id: unknown, ok: boolean, value?: unknown, error?: string) {
    this.port?.postMessage({ t: "result", id, ok, value, error });
  }

  private onMessage(m: Record<string, unknown>) {
    if (this.dead || !m || typeof m !== "object") return;
    switch (m.t) {
      case "pong":
        this.lastPong = performance.now();
        break;
      case "rendered":
        this.rendered = true;
        this.host.state({ s: "ready" });
        break;
      case "resize":
        this.host.resize(Math.min(8000, Math.max(0, Number(m.h) || 0)));
        break;
      case "error":
        this.crash("error");
        break;
      case "migrated":
        if (isObj(m.attrs) && isObj(m.data)) this.host.migrated(m.attrs, m.data);
        break;
      case "migrate-failed":
        this.dead = true;
        this.stop();
        this.host.state({ s: "migrate-failed", why: String(m.message ?? "") });
        break;
      case "focus-out":
        if (m.dir === "escape" || m.dir === "next" || m.dir === "prev") this.host.focusOut(m.dir);
        break;
      case "open-link":
        this.host.openLink(String(m.url ?? ""));
        break;
      case "set-attrs":
        try {
          const next = this.gate.attrsWrite(this.host.role(), this.host.read().attrs, m.patch);
          this.host.writeAttrs(next);
          this.reply(m.id, true, next);
        } catch (err) {
          this.reply(m.id, false, undefined, (err as Error).message);
        }
        break;
      case "set-data":
        try {
          const fields = this.gate.dataWrite(this.host.role(), this.host.read().data, m.fields);
          this.host.writeData(fields);
          this.reply(m.id, true, true);
        } catch (err) {
          this.reply(m.id, false, undefined, (err as Error).message);
        }
        break;
      case "members":
        if (this.pkg.permissions?.members !== "read") this.reply(m.id, false, undefined, "this block may not see the member list");
        // Names and pictures only, never e-mail (docs/21).
        else this.reply(m.id, true, this.host.members().map((u) => ({ id: u.id, name: u.name, avatar: u.avatar ?? null })));
        break;
    }
  }

  /** Sends the current attrs, data and role after a change in the document. */
  update() {
    if (!this.port || this.dead) return;
    const { attrs, data } = this.host.read();
    this.port.postMessage({ t: "update", attrs, data, role: this.host.role() });
  }

  theme() {
    const t = this.host.theme();
    // The frame's colour scheme must match its element's, or the browser paints an opaque
    // backdrop behind the block.
    this.iframe.style.colorScheme = t.scheme;
    this.port?.postMessage({ t: "theme", theme: t });
  }

  focus(where: "first" | "last" = "first") {
    this.iframe.focus();
    this.port?.postMessage({ t: "focus", where });
  }

  private crash(why: "error" | "hang" | "load") {
    if (this.dead) return;
    this.dead = true;
    this.stop();
    this.host.state({ s: "crashed", why });
  }

  private stop() {
    for (const t of this.timers) {
      window.clearTimeout(t);
      window.clearInterval(t);
    }
    this.timers = [];
    window.removeEventListener("message", this.onWindowMessage);
    this.port?.close();
    this.port = null;
    this.iframe.remove();
  }

  destroy() {
    this.dead = true;
    this.stop();
  }
}

/** Theme tokens the bridge sends (docs/15 §4.3): the editor's own colours, radii and font. */
export const THEME_TOKENS = ["fg", "fg-2", "fg-3", "app", "panel", "sunk", "line", "line-2", "accent", "accent-soft", "accent-fg", "red-fg", "green-fg", "amber-fg", "blue-fg", "font", "mono", "r-s", "r", "r-l"];

export function readTheme(el: Element): { scheme: "light" | "dark"; tokens: Record<string, string> } {
  const cs = getComputedStyle(el);
  const tokens: Record<string, string> = {};
  for (const t of THEME_TOKENS) {
    const v = cs.getPropertyValue("--" + t).trim();
    if (v) tokens[t] = v;
  }
  const attr = document.documentElement.getAttribute("data-theme");
  const dark = attr ? attr === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return { scheme: dark ? "dark" : "light", tokens };
}

/** Attrs a newly inserted block starts with: each required property's `default`, else an
 *  empty value of its type, so the first write already matches the schema. */
export function initialAttrs(schema: unknown): Obj {
  const out: Obj = {};
  if (!isObj(schema)) return out;
  const props = isObj(schema.properties) ? schema.properties : {};
  for (const [k, p] of Object.entries(props)) {
    if (isObj(p) && "default" in p) out[k] = clone(p.default as Json);
  }
  for (const k of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
    if (k in out) continue;
    const p = props[k];
    const t = isObj(p) ? (Array.isArray(p.type) ? p.type[0] : p.type) : undefined;
    out[k] = t === "number" || t === "integer" ? (isObj(p) && typeof p.minimum === "number" ? p.minimum : 0) : t === "boolean" ? false : t === "array" ? [] : t === "object" ? {} : "";
  }
  return out;
}
