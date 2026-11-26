// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

/*! @opencanvas/embed — <open-canvas server="…" token="…"> (docs/05 §4). No dependencies. */
(() => {
  if (typeof customElements === "undefined" || customElements.get("open-canvas")) return;
  // Where this script came from: the OpenCanvas server (for the offline helpers below).
  const SELF = (() => {
    try {
      return new URL(document.currentScript.src).origin;
    } catch {
      return null;
    }
  })();

  // canvas → host MessageIds mapped to DOM events on the element
  const EVENTS = {
    App_LoadingStatus: (v) => (v.Status === "Document_Loaded" ? ["oc:ready", v] : ["oc:loading", v]),
    Doc_ModifiedStatus: (v) => ["oc:modified", { modified: !!v.Modified }],
    Doc_Saved: (v) => ["oc:saved", v],
    Presence_Changed: (v) => ["oc:presence", v],
    Token_Expiring: (v) => ["oc:token-expiring", v],
    UI_Mention_Click: (v) => ["oc:mention-click", v],
    UI_Link_Click: (v) => ["oc:link-click", v],
    UI_FileVersions: (v) => ["oc:versions", v],
    UI_Close: (v) => ["oc:close", v],
    Error: (v) => ["oc:error", v],
    UI_OfflineState: (v) => ["oc:offline-state", v],
  };

  let seq = 0;

  class OpenCanvas extends HTMLElement {
    static get observedAttributes() {
      return ["server", "token", "theme", "offline"];
    }

    constructor() {
      super();
      this._name = "oc-frame-" + ++seq + "-" + Math.random().toString(36).slice(2, 8);
      this._onMessage = this._onMessage.bind(this);
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML =
        '<style>:host{display:block;position:relative;min-height:320px}iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent}</style>';
      this._frame = document.createElement("iframe");
      this._frame.name = this._name;
      this._frame.title = "OpenCanvas";
      this._frame.allow = "clipboard-read; clipboard-write; fullscreen";
      root.appendChild(this._frame);
    }

    connectedCallback() {
      window.addEventListener("message", this._onMessage);
      this._launch();
    }

    disconnectedCallback() {
      window.removeEventListener("message", this._onMessage);
    }

    attributeChangedCallback(name, oldV, newV) {
      if (oldV === newV || !this.isConnected) return;
      if (name === "theme") this._post("Action_Theme", { theme: newV || "auto" });
      else this._launch();
    }

    get origin() {
      try {
        return new URL(this.getAttribute("server") || "", location.href).origin;
      } catch {
        return null;
      }
    }

    /** Form-POST the launch token into the iframe so it never lands in a URL or log. */
    _launch() {
      const server = this.getAttribute("server");
      const token = this.getAttribute("token");
      if (!server || !token || this._launched === server + "|" + token) return;
      this._launched = server + "|" + token;
      const form = document.createElement("form");
      form.method = "POST";
      form.action = server.replace(/\/$/, "") + "/v1/launch";
      form.target = this._name;
      form.style.display = "none";
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "token";
      input.value = token;
      form.appendChild(input);
      // OFF-03: without a network, open the copy kept on this device (the service worker).
      if (this.hasAttribute("offline")) {
        const off = document.createElement("input");
        off.type = "hidden";
        off.name = "offline";
        off.value = "1";
        form.appendChild(off);
      }
      this.shadowRoot.appendChild(form);
      form.submit();
      form.remove();
    }

    _post(MessageId, Values) {
      const o = this.origin;
      if (!o || !this._frame.contentWindow) return;
      this._frame.contentWindow.postMessage({ MessageId, SendTime: Date.now(), Values: Values || {} }, o);
    }

    _onMessage(e) {
      if (e.source !== this._frame.contentWindow || e.origin !== this.origin) return;
      let d = e.data;
      if (typeof d === "string") {
        try {
          d = JSON.parse(d);
        } catch {
          return;
        }
      }
      if (!d || typeof d.MessageId !== "string") return;
      if (d.MessageId === "App_LoadingStatus" && d.Values && d.Values.Status === "Frame_Ready") {
        this._post("Host_PostmessageReady", {});
        const theme = this.getAttribute("theme");
        if (theme && theme !== "auto") this._post("Action_Theme", { theme });
      }
      const map = EVENTS[d.MessageId];
      if (!map) return;
      const [type, detail] = map(d.Values || {});
      this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    }

    // ---- host → canvas API ----
    /** Ask the server to save now (autosave runs regardless). */
    commit(opts) {
      this._post("Action_Commit", { message: (opts && opts.message) || undefined });
      return new Promise((resolve) => {
        const done = (e) => {
          this.removeEventListener("oc:saved", done);
          resolve(e.detail);
        };
        this.addEventListener("oc:saved", done);
      });
    }
    setReadOnly(readOnly) {
      this._post("Action_SetReadOnly", { readOnly: !!readOnly });
    }
    refresh(token) {
      this._post("Action_RefreshToken", { token });
    }
    export(format) {
      this._post("Action_Export", { format });
    }
    setTheme(theme) {
      this._post("Action_Theme", { theme });
    }
  }

  // ---- offline copies (OFF-07, docs/05 §4c) ----
  // The editor's storage is partitioned by the host's site, so both helpers run a small page
  // of the OpenCanvas server in a hidden iframe on the host's own page.
  function framePage(path, params, want, opts) {
    const server = ((opts && opts.server) || SELF || "").replace(/\/$/, "");
    if (!server) return Promise.reject(new Error("OpenCanvas: pass { server } to " + want));
    const origin = new URL(server, location.href).origin;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.hidden = true;
      f.title = "OpenCanvas offline";
      const done = (v) => {
        window.removeEventListener("message", on);
        clearTimeout(t);
        f.remove();
        resolve(v);
      };
      const on = (e) => {
        if (e.origin !== origin || e.source !== f.contentWindow || !e.data || e.data.type !== want) return;
        done(e.data);
      };
      const t = setTimeout(() => done(null), 10000);
      window.addEventListener("message", on);
      f.src = server + path + (q.toString() ? "?" + q : "");
      document.body.appendChild(f);
    });
  }

  /** Sign-out: deletes the device key first, then the offline copies, for this host (and
   *  person) in this browser. Resolves `{ removed }` (canvases removed). */
  OpenCanvas.clearOffline = (opts = {}) =>
    framePage("/v1/offline/clear", { host: opts.host, user: opts.userId }, "OC_OfflineCleared", opts).then((d) => ({ removed: d ? d.removed || 0 : 0, done: !!d }));

  /** The canvases kept on this device for `{ host, userId }`: `[{ id, title, bytes, pending,
   *  lastSent, validUntil }]`, for the host's own offline page or a sign-out warning. */
  OpenCanvas.offlineFiles = (opts = {}) =>
    framePage("/v1/offline/files", { host: opts.host, user: opts.userId }, "OC_OfflineFiles", opts).then((d) => (d ? d.files || [] : []));

  window.OpenCanvas = OpenCanvas;
  customElements.define("open-canvas", OpenCanvas);
})();
