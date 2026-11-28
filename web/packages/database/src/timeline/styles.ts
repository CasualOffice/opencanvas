// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Styles for the Timeline and Workload views (prototype v04-approved/timeline.html, `.gt`, `.bar`,
// `.wl`, `.ph-*`). Design tokens only; injected once.

export const TL_CSS = `
.ocdb-tl,.ocdb-wl,.ocdb-tl-ph{position:relative;font-size:.8125rem}
.ocdb-tl-tb{display:flex;align-items:center;gap:.375rem;padding:.5rem 0;flex-wrap:wrap}
.ocdb-tl-tb .ocdb-btn.on{background:var(--accent-soft);color:var(--accent)}
.ocdb-tl-seg{display:inline-flex;padding:.125rem;border-radius:.5rem;background:var(--sunk)}
.ocdb-tl-seg button{border:0;background:none;height:1.5rem;padding:0 .55rem;border-radius:.375rem;font-size:.75rem;color:var(--fg-2)}
.ocdb-tl-seg button[aria-pressed="true"]{background:var(--app);color:var(--fg);box-shadow:var(--sh-1)}
.ocdb-tl-gt{display:grid;grid-template-columns:minmax(8rem,15rem) 1fr;border:1px solid var(--line);border-radius:.625rem;overflow:hidden;background:var(--app)}
.ocdb-tl-l{border-right:1px solid var(--line);background:var(--app);min-width:0}
.ocdb-tl-lh{height:3rem;border-bottom:1px solid var(--line);display:flex;align-items:flex-end;padding:0 .75rem .4rem;color:var(--fg-3);font-size:.6875rem;font-weight:500;letter-spacing:.04em;text-transform:uppercase}
.ocdb-tl-grp{height:2rem;display:flex;align-items:center;padding:0 .6rem;font-weight:600;font-size:.75rem;background:var(--panel);border-bottom:1px solid var(--line);color:var(--fg-2)}
.ocdb-tl-row{height:2.25rem;display:flex;align-items:center;padding:0 .75rem;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden}
.ocdb-tl-row .nm{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;display:flex;gap:.375rem;align-items:center;cursor:default}
.ocdb-tl-r{overflow-x:auto;position:relative;overscroll-behavior-x:contain}
.ocdb-tl-cv{position:relative}
.ocdb-tl-hd{position:relative;height:3rem;border-bottom:1px solid var(--line)}
.ocdb-tl-hd .m{position:absolute;top:.35rem;font-size:.6875rem;font-weight:600;color:var(--fg-2);padding-left:.35rem;white-space:nowrap}
.ocdb-tl-hd .w{position:absolute;bottom:0;height:1.5rem;border-left:1px solid var(--line);font-size:.6875rem;color:var(--fg-3);padding:.2rem .35rem;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.ocdb-tl-hd .w.today{color:var(--red-fg);font-weight:600}
.ocdb-tl-body{position:relative;background-image:linear-gradient(to bottom,transparent calc(2.25rem - 1px),var(--line) calc(2.25rem - 1px));background-size:100% 2.25rem}
.ocdb-tl-body .g{position:absolute;left:0;right:0;height:2rem;background:var(--panel);border-bottom:1px solid var(--line)}
.ocdb-tl-body .we{position:absolute;top:0;bottom:0;background:var(--sunk);opacity:.55;pointer-events:none}
.ocdb-tl-body .now{position:absolute;top:0;bottom:0;width:2px;background:var(--red-fg);pointer-events:none;z-index:3}
.ocdb-tl-body .deps{position:absolute;left:0;top:0;pointer-events:none;z-index:3;overflow:visible}
.ocdb-tl-body .deps path{fill:none;stroke:var(--fg-3);stroke-width:.08;vector-effect:non-scaling-stroke}
.ocdb-tl-body .deps marker path{fill:var(--fg-3);stroke:none}
.ocdb-tl-body .deps path.bad{stroke:var(--red-fg);stroke-dasharray:3 2}
.ocdb-tl-body .deps path.crit{stroke:var(--red-fg)}
.ocdb-tl-bar{position:absolute;height:1.375rem;border-radius:.375rem;display:flex;align-items:center;gap:.3rem;padding:0 .45rem;font-size:.75rem;font-weight:500;white-space:nowrap;cursor:grab;z-index:4;touch-action:none;user-select:none;overflow:visible;outline-offset:2px}
.ocdb-tl-bar .fill{position:absolute;left:0;top:0;bottom:0;border-radius:inherit;pointer-events:none;background:color-mix(in srgb,currentColor 22%,transparent)}
.ocdb-tl-bar .lbl{position:relative;overflow:hidden;text-overflow:ellipsis}
.ocdb-tl-bar .after{position:absolute;left:calc(100% + .45rem);color:var(--fg-2);font-weight:400;display:flex;gap:.3rem;align-items:center;pointer-events:none}
.ocdb-tl-bar .hdl{position:absolute;top:0;bottom:0;width:.5rem;cursor:ew-resize}
.ocdb-tl-bar .hdl.l{left:0}.ocdb-tl-bar .hdl.r{right:0}
.ocdb-tl-bar .dot{position:absolute;right:-.55rem;top:50%;width:.6rem;height:.6rem;margin-top:-.3rem;border-radius:50%;background:var(--app);box-shadow:0 0 0 2px currentColor;opacity:0;cursor:crosshair}
.ocdb-tl-bar:hover .dot,.ocdb-tl-bar:focus-visible .dot{opacity:1}
.ocdb-tl-bar.crit{box-shadow:0 0 0 1.5px var(--red-fg)}
.ocdb-tl-bar.late{box-shadow:0 0 0 1.5px var(--red-fg),0 0 0 4px var(--red-bg)}
.ocdb-tl-bar.drag{cursor:grabbing;box-shadow:var(--sh-pop);z-index:6}
.ocdb-tl-ms{position:absolute;width:.9rem;height:.9rem;transform:rotate(45deg);background:var(--fg);border-radius:.15rem;z-index:4;cursor:grab;touch-action:none}
.ocdb-tl-msl{position:absolute;font-size:.75rem;font-weight:600;white-space:nowrap;pointer-events:none;z-index:4}
.ocdb-tl-tray{border-top:1px solid var(--line);padding:.5rem 0;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;color:var(--fg-2);font-size:.75rem}
.ocdb-tl-chip{display:inline-flex;gap:.3rem;align-items:center;height:1.75rem;padding:0 .5rem;border:0;border-radius:.375rem;background:var(--sunk);color:var(--fg);font-size:.75rem;cursor:grab;touch-action:none}
.ocdb-tl-toast{position:sticky;left:50%;bottom:1rem;margin:.5rem auto 0;width:max-content;max-width:100%;background:var(--pop);color:var(--fg);box-shadow:var(--sh-pop);border-radius:.75rem;padding:.6rem .75rem;display:flex;gap:.6rem;align-items:center;z-index:9;font-size:.8125rem;flex-wrap:wrap}
.ocdb-tl-toast .ic{color:var(--amber-fg)}
.ocdb-tl-gt{position:relative}
.ocdb-tl-gap{position:absolute;right:1rem;top:4rem;z-index:8;max-width:18rem;background:var(--pop);color:var(--fg-2);box-shadow:var(--sh-pop);border-radius:.75rem;padding:.875rem 1rem;display:flex;flex-direction:column;align-items:flex-start;gap:.3rem;font-size:.8125rem}
.ocdb-tl-gap b{color:var(--fg);font-size:.875rem}
.ocdb-tl-gap svg{color:var(--fg-3)}
.ocdb-tl-gap .acts{display:flex;gap:.375rem;margin-top:.375rem;flex-wrap:wrap}
.ocdb-tl-none{padding:1rem;color:var(--fg-3);display:flex;flex-direction:column;gap:.25rem}
.ocdb-tl-none b{color:var(--fg)}
.ocdb-tl-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.5rem;padding:2rem 1rem;color:var(--fg-3)}
.ocdb-tl-empty h4{margin:0;color:var(--fg);font-size:.9375rem}
.ocdb-tl-empty p{margin:0 0 .5rem;max-width:24rem;line-height:1.5}
.ocdb-tl-set{display:flex;flex-direction:column;gap:.125rem;min-width:16rem;padding:.25rem}
.ocdb-tl-fld{display:grid;grid-template-columns:8.5rem 1fr;gap:.5rem;align-items:center;padding:.3rem .4rem;font-size:.8125rem}
.ocdb-tl-fld span{color:var(--fg-2)}
.ocdb-tl-fld select,.ocdb-tl-fld input[type=number]{height:1.875rem;border:0;border-radius:.5rem;background:var(--sunk);padding:0 .5rem;font:inherit;color:inherit;min-width:0}
.ocdb-tl-fld input[type=checkbox]{justify-self:start;width:1rem;height:1rem}
.ocdb-tl-pick{display:flex;flex-direction:column;gap:.25rem;min-width:16rem;padding:.25rem}
.ocdb-tl-pick input{height:2rem;border:0;border-radius:.5rem;background:var(--sunk);padding:0 .5rem;font:inherit;color:inherit}
.ocdb-tl-pick [role=listbox]{max-height:14rem;overflow:auto}
.ocdb-mi kbd{margin-left:auto;font-family:var(--mono);font-size:.6875rem;color:var(--fg-3)}
.ocdb-mi.dan{color:var(--red-fg)}
.ocdb-tl-nudge{display:flex;gap:.5rem;padding:.25rem .625rem .5rem}
.ocdb-tl-nudge .ocdb-btn{flex:1;height:2.75rem}
/* phone list (frame 5a) */
.ocdb-tl-wk{padding:.6rem .25rem .3rem;font-size:.6875rem;font-weight:600;color:var(--fg-3);text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between}
.ocdb-tl-it{display:grid;grid-template-columns:1fr;gap:.15rem;width:100%;text-align:left;border:0;background:none;padding:.6rem .25rem;border-bottom:1px solid var(--line);min-height:2.75rem;color:var(--fg);-webkit-touch-callout:none;user-select:none}
.ocdb-tl-it .t{font-weight:500}
.ocdb-tl-it .s{color:var(--fg-3);font-size:.75rem;font-variant-numeric:tabular-nums}
.ocdb-tl-it .mini{height:.375rem;border-radius:999px;background:var(--sunk);position:relative;margin-top:.25rem}
.ocdb-tl-it .mini i{position:absolute;top:0;bottom:0;border-radius:999px;background:var(--accent)}
/* workload (frame 4a) */
.ocdb-wl-key{display:inline-flex;gap:.375rem;align-items:center;color:var(--fg-3);font-size:.75rem;flex-wrap:wrap}
.ocdb-wl-key i{display:inline-block;width:.75rem;height:.75rem;border-radius:.1875rem}
.ocdb-wl{overflow-x:auto}
.ocdb-wl-t{border-collapse:collapse;font-size:.75rem;min-width:100%}
.ocdb-wl-t th{font-weight:500;color:var(--fg-3);height:2rem;padding:0 .5rem;border-bottom:1px solid var(--line);white-space:nowrap}
.ocdb-wl-t tbody th{display:flex;gap:.5rem;align-items:center;height:2.5rem;color:var(--fg);font-size:.8125rem;text-align:left}
.ocdb-wl-t td{border-bottom:1px solid var(--line);border-left:1px solid var(--line);padding:0;min-width:4.5rem}
.ocdb-wl-t td button{width:100%;height:2.5rem;border:0;background:none;color:inherit;font:inherit;font-variant-numeric:tabular-nums;font-weight:500}
.lv0{color:var(--fg-4)}.lv1{background:var(--green-bg);color:var(--green-fg)}.lv3{background:var(--amber-bg);color:var(--amber-fg)}.lv4{background:var(--red-bg);color:var(--red-fg)}
.ocdb-wl-list{list-style:none;margin:0;padding:.25rem;display:flex;flex-direction:column;gap:.25rem;min-width:16rem}
.ocdb-wl-list li{display:flex;gap:.5rem;align-items:center}
.ocdb-wl-list .ocdb-mi.drag{cursor:grab;touch-action:none;user-select:none}
.ocdb-wl-list .ocdb-mi.drag svg{color:var(--fg-3)}
.ocdb-wl-t tr.drop th,.ocdb-wl-t tr.drop td{box-shadow:inset 0 2px 0 var(--accent),inset 0 -2px 0 var(--accent)}
.ocdb-wl-ghost{position:fixed;z-index:10000;pointer-events:none;background:var(--pop);color:var(--fg);box-shadow:var(--sh-pop);border-radius:.5rem;padding:.375rem .625rem;font-size:.8125rem;font-weight:500;white-space:nowrap}
.ocdb-wl-ghost span{color:var(--accent)}
.ocdb-tl-ph>.ocdb-tl-seg{margin:.25rem 0}
.ocdb-tl-ph>.ocdb-tl-seg button{height:2.25rem;padding:0 1rem;font-size:.8125rem}
.ocdb-wl-list select{height:1.875rem;border:0;border-radius:.5rem;background:var(--sunk);font:inherit;color:inherit}
@media (prefers-reduced-motion:reduce){.ocdb-tl-bar,.ocdb-tl-ms{transition:none}}
`;

let done = false;
export function ensureTimelineStyles() {
  if (done || typeof document === "undefined") return;
  done = true;
  const el = document.createElement("style");
  el.setAttribute("data-oc", "db-timeline");
  el.textContent = TL_CSS;
  document.head.appendChild(el);
}
