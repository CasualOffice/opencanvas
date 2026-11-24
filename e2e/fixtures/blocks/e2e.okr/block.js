// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Test block for the e2e suite (BSDK-03): an objective, a progress value and a score in the
// block's collaborative data. Plain JS against the frame runtime (window.OpenCanvasBlock).
OpenCanvasBlock.define({
  render(el, ctx) {
    const d = el.ownerDocument;
    const box = d.createElement("div");
    box.style.cssText = "padding:14px 16px;font:15px/1.5 var(--oc-font,system-ui);color:var(--oc-fg,#18181b)";
    const label = d.createElement("label");
    label.textContent = "Objective";
    label.style.cssText = "display:block;font-size:12px;color:var(--oc-fg-2,#55555c)";
    const input = d.createElement("input");
    input.setAttribute("aria-label", "Objective");
    input.style.cssText = "width:100%;font:inherit;border:1px solid var(--oc-line-2,#ccc);border-radius:6px;padding:4px 8px;background:transparent;color:inherit";
    label.append(input);
    const row = d.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px";
    const progress = d.createElement("span");
    progress.className = "progress";
    const more = d.createElement("button");
    more.textContent = "+10%";
    const score = d.createElement("span");
    score.className = "score";
    const bump = d.createElement("button");
    bump.textContent = "Score +1";
    const status = d.createElement("div");
    status.className = "status";
    status.style.cssText = "font-size:12px;margin-top:6px;color:var(--oc-fg-2,#55555c)";
    row.append(progress, more, score, bump);
    box.append(label, row, status);
    el.append(box);
    const draw = () => {
      const a = ctx.attrs;
      if (d.activeElement !== input) input.value = a.objective ?? "";
      input.readOnly = ctx.readOnly;
      more.disabled = bump.disabled = ctx.readOnly;
      progress.textContent = Math.round((a.progress ?? 0) * 100) + "%";
      score.textContent = "Score " + (ctx.data.get("score") ?? 0);
      status.textContent = ctx.readOnly ? "Read only" : "Ready";
    };
    input.addEventListener("change", () => ctx.setAttrs({ objective: input.value }).catch((e) => (status.textContent = e.message)));
    more.addEventListener("click", () => ctx.setAttrs({ progress: Math.min(1, Math.round(((ctx.attrs.progress ?? 0) + 0.1) * 10) / 10) }));
    bump.addEventListener("click", () => ctx.data.set({ score: (ctx.data.get("score") ?? 0) + 1 }));
    this._draw = draw;
    draw();
  },
  update() {
    this._draw && this._draw();
  },
});
