// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// acme.okr: the third-party sample of the approved frames (1a-6g). An objective, its key results
// with a progress and an owner each, and the overall progress (their average, stored so exports
// and readers without the package show it). Owners come from the member list when the host
// allows `members: "read"`; otherwise the owner field is free text. Viewers get no controls.
import { h, type BlockContext, type BlockDefinition, type Member } from "../../src/index";

export interface KeyResult {
  title: string;
  progress: number;
  owner?: string;
}
export interface OkrAttrs {
  objective: string;
  progress: number;
  krs: KeyResult[];
}

const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v || 0)) * 100);
/** Overall progress: the average of the key results, to two decimals. */
export const overall = (krs: KeyResult[]) => (krs.length ? Math.round((krs.reduce((s, k) => s + (k.progress || 0), 0) / krs.length) * 100) / 100 : 0);

function save(ctx: BlockContext<OkrAttrs>, krs: KeyResult[]) {
  return ctx.setAttrs({ krs, progress: overall(krs) }).catch(() => undefined);
}

export const okr: BlockDefinition<OkrAttrs> & { draw?: () => void; people?: Member[] } = {
  render(el, ctx) {
    this.people = undefined;
    const objective = h("input", { type: "text", maxLength: 200, attrs: { "aria-label": "Objective" }, style: "flex:1;min-width:0;font:inherit;font-size:17px;font-weight:600;border:0;background:transparent;color:inherit;padding:0" });
    const total = h("span", { className: "total", style: "font-variant-numeric:tabular-nums;font-weight:600" });
    const list = h("ul", { style: "list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px" });
    const add = h("button", { type: "button", textContent: "Add key result", style: "margin-top:10px;font:inherit;font-size:13px;border:1px solid var(--oc-line-2,#ccc);border-radius:8px;background:transparent;color:inherit;padding:4px 10px;cursor:pointer" });
    el.append(
      h("div", { style: "padding:14px 16px" },
        h("div", { style: "font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--oc-fg-2,#55555c)" }, "Objective"),
        h("div", { style: "display:flex;gap:12px;align-items:baseline" }, objective, total),
        list,
        add),
    );
    objective.addEventListener("change", () => void ctx.setAttrs({ objective: objective.value.slice(0, 200) }).catch(() => undefined));
    add.addEventListener("click", () => void save(ctx, [...(ctx.attrs.krs ?? []), { title: "New key result", progress: 0 }]));
    if (ctx.permissions.members === "read") void ctx.members.list().then((m) => ((this.people = m), this.draw?.())).catch(() => undefined);

    this.draw = () => {
      const a = ctx.attrs;
      const krs = a.krs ?? [];
      if (document.activeElement !== objective) objective.value = a.objective ?? "";
      objective.readOnly = ctx.readOnly;
      total.textContent = `${pct(a.progress)}%`;
      add.hidden = ctx.readOnly;
      if (list.contains(document.activeElement)) return;
      list.replaceChildren(
        ...krs.map((k, i) => {
          const title = h("input", { type: "text", value: k.title, maxLength: 200, readOnly: ctx.readOnly, attrs: { "aria-label": `Key result ${i + 1}` }, style: "flex:1;min-width:0;font:inherit;border:0;background:transparent;color:inherit;padding:0" });
          const p = h("input", { type: "range", min: "0", max: "100", step: "5", value: String(pct(k.progress)), disabled: ctx.readOnly, attrs: { "aria-label": `Progress of key result ${i + 1}` }, style: "width:120px;accent-color:var(--oc-accent,#2a5ad7)" });
          const people = this.people ?? [];
          const owner = people.length
            ? h("select", { disabled: ctx.readOnly, attrs: { "aria-label": `Owner of key result ${i + 1}` }, style: "font:inherit;font-size:13px;background:transparent;color:inherit;border:1px solid var(--oc-line-2,#ccc);border-radius:6px" },
                h("option", { value: "", textContent: "No owner" }),
                ...people.map((m) => h("option", { value: m.id, textContent: m.name, selected: m.id === k.owner })))
            : null;
          const edit = (patch: Partial<KeyResult>) => save(ctx, krs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          title.addEventListener("change", () => void edit({ title: title.value.slice(0, 200) }));
          p.addEventListener("change", () => void edit({ progress: Number(p.value) / 100 }));
          owner?.addEventListener("change", () => void edit({ owner: (owner as HTMLSelectElement).value || undefined }));
          return h("li", { style: "display:flex;gap:10px;align-items:center" }, title, p, h("span", { textContent: `${pct(k.progress)}%`, style: "width:3em;text-align:right;font-variant-numeric:tabular-nums;color:var(--oc-fg-2,#55555c)" }), owner);
        }),
      );
    };
    this.draw();
  },
  update() {
    this.draw?.();
  },
};
