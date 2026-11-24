// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// The block frame runtime (BSDK-03, docs/27 §3.4, docs/15 §4.3). Inlined into every block frame
// served from the block origin; its sha384 is the only inline script the frame's CSP allows.
// The frame is `sandbox="allow-scripts"` without `allow-same-origin`: an opaque origin with
// no cookies, no storage of the editor's and no access to the editor's DOM. This runtime is the
// block's only way out: a typed RPC over a MessageChannel the editor hands over once, after
// checking that the "ready" message came from this very frame.
(() => {
  "use strict";
  const cfg = JSON.parse(document.getElementById("oc-config").textContent);
  let port = null;
  let def = null;
  let migrations = null;
  let state = null; // {attrs, data, role, theme, type, v, permissions}
  let seq = 0;
  let started = false;
  const pending = new Map();
  const observers = new Set();

  const post = (msg) => port && port.postMessage(msg);
  const call = (t, body) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post({ t, id, ...body });
    });
  const freeze = (v) => JSON.parse(JSON.stringify(v ?? null));

  const ctx = {
    get type() { return state.type; },
    get v() { return state.v; },
    get attrs() { return freeze(state.attrs) ?? {}; },
    get role() { return state.role; },
    get readOnly() { return state.role !== "edit"; },
    get theme() { return freeze(state.theme); },
    get permissions() { return freeze(state.permissions); },
    setAttrs: (patch) => call("set-attrs", { patch: freeze(patch) }),
    data: {
      get: (key) => freeze((state.data ?? {})[key]),
      all: () => freeze(state.data) ?? {},
      set: (fields) => call("set-data", { fields: freeze(fields) }),
      observe: (fn) => (observers.add(fn), () => observers.delete(fn)),
    },
    resize: (h) => post({ t: "resize", h: Math.max(0, Math.round(Number(h) || 0)) }),
    openLink: (url) => post({ t: "open-link", url: String(url) }),
    members: { list: () => call("members", {}) },
  };

  function applyTheme(t) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t?.tokens ?? {})) {
      if (/^[a-z0-9-]{1,40}$/.test(k) && typeof v === "string" && v.length < 200) root.style.setProperty("--oc-" + k, v);
    }
    root.style.colorScheme = t?.scheme === "dark" ? "dark" : "light";
    root.dataset.theme = t?.scheme === "dark" ? "dark" : "light";
  }

  function runMigrations(from, to, attrs, data) {
    let cur = { attrs: freeze(attrs) ?? {}, data: freeze(data) ?? {} };
    for (let v = from; v < to; v++) {
      const step = migrations && migrations[String(v)];
      if (typeof step !== "function") throw new Error("no migration from version " + v);
      const out = step(freeze(cur.attrs), freeze(cur.data));
      cur = { attrs: freeze(out && out.attrs) ?? {}, data: freeze(out && out.data) ?? {} };
    }
    return cur;
  }

  function start() {
    if (started || !def || !state) return;
    started = true;
    const root = document.getElementById("oc-root");
    try {
      def.render(root, ctx);
      post({ t: "rendered" });
    } catch (e) {
      post({ t: "error", message: String((e && e.message) || e).slice(0, 300) });
    }
  }

  function onMessage(e) {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "init": {
        state = { attrs: m.attrs, data: m.data, role: m.role, theme: m.theme, type: m.type, v: m.v, permissions: m.permissions };
        applyTheme(m.theme);
        if (m.migrate) {
          try {
            const out = runMigrations(m.migrate.from, m.migrate.to, m.attrs, m.data);
            state.attrs = out.attrs;
            state.data = out.data;
            post({ t: "migrated", attrs: out.attrs, data: out.data });
          } catch (err) {
            post({ t: "migrate-failed", message: String((err && err.message) || err).slice(0, 300) });
            return;
          }
        }
        start();
        break;
      }
      case "update": {
        if (!state) return;
        state.attrs = m.attrs;
        state.data = m.data;
        if (m.role) state.role = m.role;
        try {
          def && def.update && def.update(ctx);
          for (const fn of observers) fn(ctx.data.all());
        } catch (err) {
          post({ t: "error", message: String((err && err.message) || err).slice(0, 300) });
        }
        break;
      }
      case "theme":
        if (state) state.theme = m.theme;
        applyTheme(m.theme);
        try { def && def.update && def.update(ctx); } catch { /* the block's own problem */ }
        break;
      case "ping":
        post({ t: "pong", n: m.n });
        break;
      case "focus": {
        const all = tabbables();
        (m.where === "last" ? all[all.length - 1] : all[0])?.focus();
        if (!all.length) document.getElementById("oc-root").focus();
        break;
      }
      case "result": {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error || "refused"));
        break;
      }
    }
  }

  function tabbables() {
    return Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]"))
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
  }

  // Escape and Tab past the ends go back to the editor (the editor keeps its keyboard model).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      post({ t: "focus-out", dir: "escape" });
    } else if (e.key === "Tab") {
      const all = tabbables();
      const first = all[0];
      const last = all[all.length - 1];
      const at = document.activeElement;
      if ((!e.shiftKey && (at === last || !all.length)) || (e.shiftKey && (at === first || !all.length))) {
        e.preventDefault();
        post({ t: "focus-out", dir: e.shiftKey ? "prev" : "next" });
      }
    }
  }, true);

  window.addEventListener("error", (e) => post({ t: "error", message: String(e.message || "error").slice(0, 300) }));
  window.addEventListener("unhandledrejection", (e) => post({ t: "error", message: String((e.reason && e.reason.message) || e.reason || "error").slice(0, 300) }));

  let lastH = -1;
  const report = () => {
    const h = Math.ceil(document.getElementById("oc-root").getBoundingClientRect().height);
    if (h !== lastH) {
      lastH = h;
      post({ t: "resize", h });
    }
  };
  new ResizeObserver(report).observe(document.getElementById("oc-root"));

  // One handshake: the editor answers "ready" with a port; nothing else is accepted from window.
  window.addEventListener("message", (e) => {
    if (port || e.source !== window.parent) return;
    if (cfg.parent !== "*" && e.origin !== cfg.parent) return;
    if (!e.data || e.data.t !== "connect" || !e.ports || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = onMessage;
    report();
  });

  window.OpenCanvasBlock = Object.freeze({
    version: 1,
    define(d) {
      if (def) throw new Error("define() was already called");
      if (!d || typeof d.render !== "function") throw new Error("define() needs render(el, ctx)");
      def = d;
      start();
    },
    defineMigrations(m) {
      if (migrations) throw new Error("defineMigrations() was already called");
      migrations = Object.freeze({ ...m });
    },
  });

  window.addEventListener("load", () => {
    window.parent.postMessage({ t: "ready", type: cfg.type, version: cfg.version }, cfg.parent);
  });
})();
