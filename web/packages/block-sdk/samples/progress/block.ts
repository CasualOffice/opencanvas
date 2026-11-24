// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// oc.progress: OpenCanvas's own first-party block on the SDK contract (docs/27 §3.3), so the
// contract stays honest. A label and a value 0-100 %, drawn as a bar in the editor's colours.
import { h, type BlockDefinition } from "../../src/index";

export interface ProgressAttrs {
  label: string;
  value: number;
}

const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v || 0)) * 100);

export const progress: BlockDefinition<ProgressAttrs> & { draw?: () => void } = {
  render(el, ctx) {
    const label = h("input", { type: "text", maxLength: 80, attrs: { "aria-label": "Label" }, style: "flex:1;min-width:0;font:inherit;font-weight:600;border:0;background:transparent;color:inherit;padding:0" });
    const value = h("span", { style: "font-variant-numeric:tabular-nums;color:var(--oc-fg-2,#55555c)" });
    const fill = h("div", { style: "height:100%;border-radius:999px;background:var(--oc-accent,#2a5ad7);transition:width .15s" });
    const track = h("div", { attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, style: "height:8px;border-radius:999px;background:var(--oc-sunk,#f4f4f2);overflow:hidden;margin-top:8px" }, fill);
    const slider = h("input", { type: "range", min: "0", max: "100", step: "5", attrs: { "aria-label": "Progress value" }, style: "width:100%;margin-top:10px;accent-color:var(--oc-accent,#2a5ad7)" });
    el.append(h("div", { style: "padding:14px 16px" }, h("div", { style: "display:flex;gap:12px;align-items:baseline" }, label, value), track, slider));
    label.addEventListener("change", () => void ctx.setAttrs({ label: label.value.slice(0, 80) }).catch(() => undefined));
    slider.addEventListener("change", () => void ctx.setAttrs({ value: Number(slider.value) / 100 }).catch(() => undefined));
    this.draw = () => {
      const a = ctx.attrs;
      const p = pct(a.value);
      if (document.activeElement !== label) label.value = a.label ?? "";
      label.readOnly = ctx.readOnly;
      value.textContent = `${p}%`;
      fill.style.width = `${p}%`;
      track.setAttribute("aria-valuenow", String(p));
      track.setAttribute("aria-label", a.label || "Progress");
      slider.value = String(p);
      slider.hidden = ctx.readOnly;
    };
    this.draw();
  },
  update() {
    this.draw?.();
  },
};
