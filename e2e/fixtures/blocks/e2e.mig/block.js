// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Test block with a script migration (BSDK-03 / ADR-060): data version 2 renamed `name` to
// `title`; migrations.js runs in the sandbox on older data.
OpenCanvasBlock.define({
  render(el, ctx) {
    const d = el.ownerDocument;
    const p = d.createElement("p");
    p.className = "title";
    const b = d.createElement("button");
    b.textContent = "Touch";
    b.onclick = () => ctx.setAttrs({ touched: true });
    el.append(p, b);
    this._draw = () => (p.textContent = "Title: " + (ctx.attrs.title ?? ""));
    this._draw();
  },
  update() {
    this._draw && this._draw();
  },
});
