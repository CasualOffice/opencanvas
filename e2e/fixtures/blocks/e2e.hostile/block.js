// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// A hostile test block (BSDK-03 security suite). It tries what a block must not be able to do
// and writes what happened into its own frame, where the test reads it:
//   cookie, storage, parent DOM, top navigation, a fetch outside its permissions,
//   a schema-invalid write, a write flood (rate limit); and on request it crashes or hangs.
OpenCanvasBlock.define({
  render(el, ctx) {
    const d = el.ownerDocument;
    const out = d.createElement("pre");
    out.className = "report";
    el.append(out);
    const report = {};
    const set = (k, v) => {
      report[k] = v;
      out.textContent = Object.keys(report).sort().map((x) => x + "=" + report[x]).join("\n");
    };
    const attempt = (k, fn) => {
      try {
        fn();
        set(k, "allowed");
      } catch (e) {
        set(k, "blocked");
      }
    };
    attempt("cookie", () => {
      const c = d.cookie;
      if (typeof c !== "string") throw new Error("no cookie");
    });
    attempt("storage", () => window.localStorage.setItem("x", "1"));
    attempt("parentDom", () => {
      const t = window.parent.document.title;
      if (typeof t !== "string") throw new Error("no");
    });
    attempt("topNav", () => {
      window.top.location.href = "https://example.com/escaped";
    });
    fetch("http://localhost:8280/healthz").then(() => set("fetchOut", "allowed"), () => set("fetchOut", "blocked"));
    ctx.setAttrs({ count: "not a number" }).then(() => set("invalidWrite", "allowed"), (e) => set("invalidWrite", "refused: " + e.message));
    let refused = 0;
    const flood = [];
    for (let i = 0; i < 150; i++) flood.push(ctx.setAttrs({ count: i }).catch(() => refused++));
    Promise.all(flood).then(() => set("flood", refused > 0 ? "rate limited " + refused : "not limited"));
    const crash = d.createElement("button");
    crash.textContent = "Crash";
    crash.onclick = () => {
      throw new Error("boom");
    };
    const hang = d.createElement("button");
    hang.textContent = "Hang";
    hang.onclick = () => {
      // Longer than the 5 s heartbeat; short enough that a browser running both frames in one
      // process gets its thread back and notices.
      const end = Date.now() + 8_000;
      while (Date.now() < end) {
        /* hang the frame */
      }
    };
    el.append(crash, hang);
  },
});
