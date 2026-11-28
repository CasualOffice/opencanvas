// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The graph picture (GRAPH-02/03, prototype frames 1a, 1b, 3a, 4b, 5a): an SVG of circles and
// lines drawn straight to the DOM (React would re-render 2,000 nodes 60 times a second), with
// hover, selection, drag to pin, pan, wheel and pinch zoom, and the keyboard model of frame 4b.
// Positions come from the layout worker (runner.ts).
import { canvasOf, describeNode, pickDirection, type View, type VNode } from "./model";
import { runner, type Runner } from "./runner";

const NS = "http://www.w3.org/2000/svg";

export interface EngineOpts {
  label: string;
  /** The canvas this editor shows (accent ring; first keyboard focus). */
  current: string | null;
  /** Held in the middle (the local graph's root). */
  center: string | null;
  /** Labels always shown from this many links. */
  bigDeg: number;
  maxFit: number;
  pad: number;
  charge?: number;
  len?: number;
  pins: Map<string, [number, number]>;
  onPins(p: Map<string, [number, number]>): void;
  onHover(id: string | null): void;
  onSelect(id: string | null): void;
  onOpen(id: string): void;
  onKey(k: "slash" | "list"): void;
  /** Called after positions or the zoom changed (the card follows its node). */
  onFrame(): void;
  say(text: string): void;
}

interface N extends VNode {
  i: number;
  x: number;
  y: number;
  r: number;
  g?: SVGGElement;
  shape?: SVGElement;
}
interface E {
  s: N;
  t: N;
  k: string;
  el?: SVGLineElement;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function el<K extends keyof SVGElementTagNameMap>(n: K, a: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, n);
  for (const k in a) e.setAttribute(k, String(a[k]));
  return e;
}
function safeMatches(e: Element, sel: string) {
  try {
    return e.matches(sel);
  } catch {
    return false;
  }
}

export class Engine {
  /** The last input in the graph was a key (the focus ring shows). */
  private keyed = false;
  readonly svg: SVGSVGElement;
  private gvp: SVGGElement;
  private ge: SVGGElement;
  private gn: SVGGElement;
  private nodes: N[] = [];
  private edges: E[] = [];
  private byId = new Map<string, N>();
  private v: View | null = null;
  private sig = "";
  private pos = new Map<string, [number, number]>();
  private T = { x: 0, y: 0, k: 1 };
  private userView = false;
  private gen = 0;
  private fitted = -1;
  private run: Runner;
  private hover: string | null = null;
  sel: string | null = null;
  kf: string | null = null;
  private colour: (n: VNode) => string = () => "var(--fg-3)";
  private W = 0;
  private H = 0;
  private ro: ResizeObserver | null = null;
  private off: (() => void)[] = [];

  constructor(
    private host: HTMLElement,
    private o: EngineOpts,
  ) {
    this.svg = el("svg", { class: "gr-svg", tabindex: 0, role: "application", "aria-roledescription": "graph", "aria-label": `${o.label}. Arrow keys move between linked canvases, Enter opens, Space selects, P pins, L shows the list.` });
    this.gvp = el("g", { class: "gr-vp" });
    this.ge = el("g", { class: "gr-e" });
    this.gn = el("g", { class: "gr-n" });
    this.gvp.append(this.ge, this.gn);
    this.svg.append(this.gvp);
    host.prepend(this.svg);
    this.measure();
    this.run = runner((x, y, done, gen) => this.frame(x, y, done, gen));
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => {
        const w = this.W,
          h = this.H;
        this.measure();
        if ((w !== this.W || h !== this.H) && !this.userView) this.fit();
      });
      this.ro.observe(host);
    }
    this.wire();
  }

  private measure() {
    this.W = this.host.clientWidth || 600;
    this.H = this.host.clientHeight || 400;
  }

  destroy() {
    this.run.stop();
    this.ro?.disconnect();
    this.off.forEach((f) => f());
    this.svg.remove();
  }

  // ---------- data ----------

  /** `center`: the node held in the middle (a local graph's root), if any. */
  setView(v: View, colour: (n: VNode) => string, center: string | null = this.o.center) {
    this.v = v;
    this.colour = colour;
    const sig = `${center}/` + v.nodes.map((n) => n.id).join("|") + "/" + v.edges.map((e) => e.s + ">" + e.t + e.k).join("|");
    this.o.center = center;
    if (sig === this.sig) return this.style();
    const had = this.nodes.length;
    this.sig = sig;
    for (const n of this.nodes) this.pos.set(n.id, [n.x, n.y]);
    this.nodes = v.nodes.map((n, i) => {
      const p = this.pos.get(n.id);
      return { ...n, i, x: p?.[0] ?? this.W / 2, y: p?.[1] ?? this.H / 2, r: n.kind === "block" ? 4.6 : 5 + Math.sqrt(n.in + n.out) * 2.7 };
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = v.edges.map((e) => ({ s: this.byId.get(e.s)!, t: this.byId.get(e.t)!, k: e.k }));
    for (const id of [this.sel, this.hover, this.kf]) if (id && !this.byId.has(id)) this.clear(id);
    this.draw();
    const known = this.nodes.filter((n) => this.pos.has(n.id)).map((n): [string, [number, number]] => [n.id, [n.x, n.y]]);
    const pins = [...this.o.pins].filter(([id]) => this.byId.has(id));
    const ci = center ? this.byId.get(center)?.i : undefined;
    this.userView = false;
    this.run.send({
      t: "start",
      gen: ++this.gen,
      input: { nodes: this.nodes.map((n) => ({ id: n.id, r: n.r })), edges: this.edges.map((e) => [e.s.i, e.t.i, e.k === "in" ? 1 : 0]), w: this.W, h: this.H, center: ci, charge: this.o.charge, len: this.o.len },
      known,
      pins,
      alpha: had && known.length ? 0.45 : 1,
      still: reduced(),
      seed: 11,
    });
  }

  private clear(id: string) {
    if (this.sel === id) (this.sel = null), this.o.onSelect(null);
    if (this.hover === id) (this.hover = null), this.o.onHover(null);
    if (this.kf === id) this.kf = null;
  }

  private frame(x: Float32Array, y: Float32Array, done: boolean, gen: number) {
    if (gen !== this.gen || x.length !== this.nodes.length) return;
    for (const n of this.nodes) (n.x = x[n.i]), (n.y = y[n.i]);
    // Fit on the first frame and when it settles, not on every frame (the picture would breathe).
    if (!this.userView && (done || this.fitted !== gen)) this.fit(false);
    this.fitted = gen;
    this.place();
    if (done) this.declutter();
  }

  // ---------- drawing ----------

  private draw() {
    this.ge.textContent = "";
    this.gn.textContent = "";
    for (const e of this.edges) {
      e.el = el("line", { class: "k-" + e.k });
      this.ge.append(e.el);
    }
    for (const n of this.nodes) {
      const g = el("g", { class: "nd" + (n.kind === "block" ? " blk" : ""), "data-id": n.id });
      if (n.kind === "canvas") {
        g.append(el("circle", { class: "ring", r: n.r + 4.5 }), el("circle", { class: "sring", r: n.r + 2.8 }), el("circle", { class: "kring", r: n.r + 6.5 }));
        n.shape = el("circle", { class: "c", r: n.r });
      } else {
        g.append(el("rect", { class: "sring", x: -n.r - 2.8, y: -n.r - 2.8, width: 2 * n.r + 5.6, height: 2 * n.r + 5.6, rx: 3 }), el("rect", { class: "kring", x: -n.r - 5, y: -n.r - 5, width: 2 * n.r + 10, height: 2 * n.r + 10, rx: 4 }));
        n.shape = el("rect", { class: "c", x: -n.r, y: -n.r, width: 2 * n.r, height: 2 * n.r, rx: 1.6 });
      }
      g.append(n.shape, el("circle", { class: "pinmark", cx: n.r * 0.75, cy: -n.r * 0.75, r: 2.6 }));
      const t = el("text", { class: "gl", "text-anchor": "middle", y: n.r + 12 });
      t.textContent = n.title;
      g.append(t);
      n.g = g;
      this.gn.append(g);
    }
    this.style();
    this.place();
  }

  private place() {
    for (const n of this.nodes) n.g?.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    for (const e of this.edges) {
      const S = e.s,
        D = e.t,
        dx = D.x - S.x,
        dy = D.y - S.y,
        d = Math.hypot(dx, dy) || 1,
        hl = e.el!.classList.contains("hl");
      const a = S.r + 1,
        b = D.r + (hl ? 3.5 : 1.5);
      e.el!.setAttribute("x1", (S.x + (dx / d) * a).toFixed(1));
      e.el!.setAttribute("y1", (S.y + (dy / d) * a).toFixed(1));
      e.el!.setAttribute("x2", (D.x - (dx / d) * b).toFixed(1));
      e.el!.setAttribute("y2", (D.y - (dy / d) * b).toFixed(1));
    }
    this.o.onFrame();
  }

  /** Classes for hover, selection, search, focus and pins; colours. */
  style() {
    const v = this.v;
    if (!v) return;
    const f = this.hover ?? this.sel;
    const fs = f && this.byId.has(f) ? new Set([f, ...(v.nb.get(f) ?? [])]) : null;
    const ms = v.matches;
    // The focus ring follows the keyboard only (a click focuses the graph too).
    const foc = document.activeElement === this.svg && (this.keyed || safeMatches(this.svg, ":focus-visible"));
    for (const n of this.nodes) {
      const c = n.g!.classList,
        inF = !!fs?.has(n.id),
        inM = !!ms?.has(n.id);
      c.toggle("dim", (!!fs && !inF) || (!!ms && !inM && !inF));
      c.toggle("hl", inF || inM);
      c.toggle("sel", n.id === this.sel);
      c.toggle("cur", n.id === this.o.current);
      c.toggle("kf", foc && n.id === this.kf);
      c.toggle("big", n.kind === "canvas" && n.in + n.out >= this.o.bigDeg);
      c.toggle("pinned", this.o.pins.has(n.id));
      const col = this.colour(n);
      if (n.kind === "canvas") (n.shape as SVGElement).style.fill = col;
      else ((n.shape as SVGElement).style.fill = "var(--app)"), ((n.shape as SVGElement).style.stroke = col);
    }
    for (const e of this.edges) {
      const inc = !!f && (e.s.id === f || e.t.id === f);
      const dim = (!!f && !inc) || (!!ms && !inc && !(ms.has(e.s.id) || ms.has(e.t.id)));
      e.el!.classList.toggle("hl", inc);
      e.el!.classList.toggle("dim", dim);
      if (inc && e.k !== "in") e.el!.setAttribute("marker-end", "url(#gr-arr)");
      else e.el!.removeAttribute("marker-end");
    }
  }

  /** Hides labels that would sit on another label or node (shown again on hover or zoom). */
  private declutter() {
    const boxes: number[][] = [];
    const k = this.T.k;
    const cands = this.nodes.filter((n) => n.g!.classList.contains("big") || n.id === this.o.current).sort((a, b) => Number(b.id === this.o.current) - Number(a.id === this.o.current) || b.in + b.out - (a.in + a.out));
    for (const n of cands) {
      const w = (n.title.length * 6.4) / k,
        h = 14 / k,
        x0 = n.x - w / 2,
        y0 = n.y + n.r + 12 - h * 0.85;
      const hit = boxes.some((b) => x0 < b[2] && x0 + w > b[0] && y0 < b[3] && y0 + h > b[1]) || this.nodes.some((q) => q !== n && q.x + q.r > x0 && q.x - q.r < x0 + w && q.y + q.r > y0 && q.y - q.r < y0 + h);
      n.g!.classList.toggle("lx", hit);
      if (!hit) boxes.push([x0, y0, x0 + w, y0 + h]);
    }
  }

  // ---------- view transform ----------

  private applyT() {
    this.gvp.setAttribute("transform", `translate(${this.T.x.toFixed(1)},${this.T.y.toFixed(1)}) scale(${this.T.k.toFixed(3)})`);
    this.svg.style.setProperty("--k", this.T.k.toFixed(3));
    this.svg.classList.toggle("zin", this.T.k > 1.7);
    this.o.onFrame();
  }

  fit(user = true) {
    if (user) this.userView = false;
    if (!this.nodes.length) return;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const n of this.nodes) {
      const c = n.g?.classList;
      const hw = c && (c.contains("big") || c.contains("cur") || c.contains("sel")) ? Math.max(n.r, n.title.length * 3.15) : n.r;
      x0 = Math.min(x0, n.x - hw);
      x1 = Math.max(x1, n.x + hw);
      y0 = Math.min(y0, n.y - n.r);
      y1 = Math.max(y1, n.y + n.r + 16);
    }
    const pad = this.o.pad;
    const k = Math.min((this.W - 2 * pad) / Math.max(x1 - x0, 1), (this.H - 2 * pad) / Math.max(y1 - y0, 1), this.o.maxFit);
    this.T = { k: Math.max(0.2, k), x: this.W / 2 - ((x0 + x1) / 2) * k, y: this.H / 2 - ((y0 + y1) / 2) * k };
    this.applyT();
  }

  zoomBy(f: number, at: [number, number] = [this.W / 2, this.H / 2]) {
    const k = Math.max(0.25, Math.min(4, this.T.k * f));
    this.T.x = at[0] - ((at[0] - this.T.x) * k) / this.T.k;
    this.T.y = at[1] - ((at[1] - this.T.y) * k) / this.T.k;
    this.T.k = k;
    this.userView = true;
    this.applyT();
  }

  /** A node's centre and radius in the host's pixels. */
  screenOf(id: string): { x: number; y: number; r: number } | null {
    const n = this.byId.get(id);
    if (!n) return null;
    return { x: this.T.x + n.x * this.T.k, y: this.T.y + n.y * this.T.k, r: n.r * this.T.k };
  }

  private ensureVisible(n: N) {
    const p = this.screenOf(n.id)!;
    if (p.x < 30 || p.x > this.W - 30 || p.y < 30 || p.y > this.H - 30) {
      this.T.x += this.W / 2 - p.x;
      this.T.y += this.H / 2 - p.y;
      this.userView = true;
      this.applyT();
    }
  }

  // ---------- selection, pins ----------

  select(id: string | null, announce = true) {
    this.sel = id;
    this.style();
    this.place();
    this.o.onSelect(id);
    if (id && announce && this.v) this.o.say("Selected " + describeNode(this.v, id, this.o.pins.has(id)));
  }

  togglePin(id: string) {
    const n = this.byId.get(id);
    if (!n) return;
    const pins = new Map(this.o.pins);
    if (pins.has(id)) {
      pins.delete(id);
      this.run.send({ t: "pin", i: n.i, x: null, y: null, heat: 0.2 });
      this.o.say(`${n.title} unpinned`);
    } else {
      pins.set(id, [n.x, n.y]);
      this.run.send({ t: "pin", i: n.i, x: n.x, y: n.y, heat: 0 });
      this.o.say(`${n.title} pinned`);
    }
    this.o.pins = pins;
    this.o.onPins(pins);
    this.style();
  }

  unpinAll() {
    for (const id of this.o.pins.keys()) {
      const n = this.byId.get(id);
      if (n) this.run.send({ t: "pin", i: n.i, x: null, y: null, heat: 0 });
    }
    this.o.pins = new Map();
    this.o.onPins(this.o.pins);
    this.run.send({ t: "reheat", heat: 0.35 });
    this.style();
    this.o.say("All canvases unpinned");
  }

  setPins(p: Map<string, [number, number]>) {
    this.o.pins = p;
  }

  isPinned(id: string) {
    return this.o.pins.has(id);
  }

  // ---------- input ----------

  private on<K extends keyof SVGElementEventMap>(t: K, f: (e: SVGElementEventMap[K]) => void, opt?: AddEventListenerOptions) {
    this.svg.addEventListener(t, f as EventListener, opt);
    this.off.push(() => this.svg.removeEventListener(t, f as EventListener, opt));
  }

  private pt(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private wire() {
    const ptrs = new Map<number, [number, number]>();
    let drag: { n: N; start: [number, number] } | null = null,
      pan: { start: [number, number]; tx: number; ty: number } | null = null,
      pinch: { d: number; k: number } | null = null,
      moved = false;
    const nodeAt = (e: Event) => (e.target as Element).closest?.(".nd")?.getAttribute("data-id") ?? null;
    this.on("pointerdown", (e) => {
      this.keyed = false;
      if (e.button > 0) return;
      ptrs.set(e.pointerId, this.pt(e));
      try {
        this.svg.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      moved = false;
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        drag = pan = null;
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: this.T.k };
        return;
      }
      const id = nodeAt(e);
      if (id && this.byId.has(id)) drag = { n: this.byId.get(id)!, start: this.pt(e) };
      else pan = { start: this.pt(e), tx: this.T.x, ty: this.T.y };
    });
    this.on("pointermove", (e) => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, this.pt(e));
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.zoomBy((pinch.k * d) / pinch.d / this.T.k, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        moved = true;
        return;
      }
      const p = this.pt(e);
      if (drag) {
        if (!moved && Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) < 4) return;
        moved = true;
        const gx = (p[0] - this.T.x) / this.T.k,
          gy = (p[1] - this.T.y) / this.T.k;
        drag.n.x = gx;
        drag.n.y = gy;
        this.o.pins.set(drag.n.id, [gx, gy]);
        this.run.send({ t: "pin", i: drag.n.i, x: gx, y: gy, heat: 0.22 });
        drag.n.g!.classList.add("pinned");
        this.place();
        return;
      }
      if (pan) {
        if (!moved && Math.hypot(p[0] - pan.start[0], p[1] - pan.start[1]) < 4) return;
        moved = true;
        this.T.x = pan.tx + p[0] - pan.start[0];
        this.T.y = pan.ty + p[1] - pan.start[1];
        this.userView = true;
        this.applyT();
        return;
      }
      if (e.pointerType === "mouse") {
        const id = nodeAt(e);
        if (id !== this.hover) {
          this.hover = id;
          this.style();
          this.place();
          this.o.onHover(id);
        }
      }
    });
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId);
      if (drag) {
        if (!moved) this.select(this.sel === drag.n.id && e.pointerType === "mouse" ? null : drag.n.id);
        else {
          this.o.pins = new Map(this.o.pins);
          this.o.onPins(this.o.pins);
          this.o.say(`${drag.n.title} pinned`);
          this.style();
        }
        drag = null;
      } else if (pan) {
        if (!moved) this.select(null);
        pan = null;
      }
      if (ptrs.size < 2) pinch = null;
    };
    this.on("pointerup", up);
    this.on("pointercancel", up);
    this.on("pointerleave", (e) => {
      if (e.pointerType === "mouse" && this.hover && !drag) {
        this.hover = null;
        this.style();
        this.place();
        this.o.onHover(null);
      }
    });
    this.on("dblclick", (e) => {
      const id = nodeAt(e);
      if (id) this.o.onOpen(id);
    });
    this.on("wheel", (e) => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), this.pt(e));
    }, { passive: false });
    this.on("focus", () => {
      if (!this.kf || !this.byId.has(this.kf)) {
        const top = [...this.nodes].filter((n) => n.kind === "canvas").sort((a, b) => b.in + b.out - (a.in + a.out))[0];
        this.kf = this.o.current && this.byId.has(this.o.current) ? this.o.current : top?.id ?? null;
      }
      this.style();
      if (this.kf && this.v) {
        this.ensureVisible(this.byId.get(this.kf)!);
        this.o.say(describeNode(this.v, this.kf, this.o.pins.has(this.kf)));
      }
    });
    this.on("blur", () => this.style());
    this.on("keydown", (e) => this.key(e));
  }

  private key(e: KeyboardEvent) {
    const k = e.key;
    if (k !== "Tab") this.keyed = true;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === "/") return e.preventDefault(), this.o.onKey("slash");
    if (k === "l" || k === "L") return e.preventDefault(), this.o.onKey("list");
    if (k === "f" || k === "F") return this.fit(), this.o.say(`Fitted ${this.nodes.length} ${this.nodes.length === 1 ? "node" : "nodes"}`);
    if (k === "+" || k === "=") return this.zoomBy(1.25);
    if (k === "-") return this.zoomBy(1 / 1.25);
    if (k === "Escape" && this.sel) return e.stopPropagation(), this.select(null);
    if (!this.kf || !this.v) return;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (dirs[k]) {
      e.preventDefault();
      const cur = this.byId.get(this.kf)!;
      const nbs = [...(this.v.nb.get(this.kf) ?? [])].map((id) => this.byId.get(id)!);
      const b = pickDirection(cur, dirs[k], nbs) ?? pickDirection(cur, dirs[k], this.nodes);
      if (b) {
        this.kf = b.id;
        this.style();
        this.ensureVisible(b);
        this.o.onFrame();
        this.o.say(describeNode(this.v, b.id, this.o.pins.has(b.id)));
      } else this.o.say("No canvas in that direction");
    } else if (k === "Enter") {
      e.preventDefault();
      this.o.onOpen(this.kf);
    } else if (k === " ") {
      e.preventDefault();
      this.select(this.sel === this.kf ? null : this.kf);
    } else if (k === "p" || k === "P") this.togglePin(this.kf);
  }

  focus() {
    this.svg.focus();
  }

  /** The canvas a block node belongs to, or the node itself. */
  static fileOf(id: string) {
    return canvasOf(id);
  }
}
