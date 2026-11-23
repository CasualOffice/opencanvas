// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram mode styles (DGM-14). Injected once, from the lazy diagram chunk. Tokens only
// (light and dark come from @opencanvas/ui/tokens.css). Units: rem for UI (ADR-050).

export const DIAGRAM_CSS = `
.ocdg{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--app);color:var(--fg);font-family:var(--font);font-size:.875rem;line-height:1.5;-webkit-font-smoothing:antialiased}
.ocdg *{box-sizing:border-box}
:where(.ocdg) :where(button){font:inherit;color:inherit;cursor:pointer}
.ocdg :focus-visible,.ocdg .ocbd :focus-visible{outline:.15625rem solid var(--accent);outline-offset:.125rem}
.ocdg svg.lucide{flex:none;display:block}
.ocdg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ocdg-top{height:3rem;flex:none;display:flex;align-items:center;gap:.25rem;padding:0 .625rem;border-bottom:1px solid var(--line);background:var(--app);position:relative;z-index:3}
.ocdg-back{display:inline-flex;align-items:center;gap:.375rem;height:2rem;padding:0 .625rem 0 .5rem;border:0;border-radius:.5rem;background:none;color:var(--fg-2);font-size:.8125rem;font-weight:500;white-space:nowrap}
.ocdg-back:hover{background:var(--hover);color:var(--fg)}
.ocdg-vs{width:1px;height:1.25rem;background:var(--line-2);margin:0 .375rem;flex:none}
.ocdg-crumb{display:flex;align-items:center;gap:.375rem;min-width:0;font-size:.8125rem}
.ocdg-doc{color:var(--fg-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:16rem}
.ocdg-sl{color:var(--fg-4)}
.ocdg-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:20rem}
.ocdg-sp{flex:1}
.ocdg-people{display:flex;list-style:none;margin:0 .5rem 0 0;padding:0}
.ocdg-av{width:1.625rem;height:1.625rem;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:.625rem;font-weight:600;box-shadow:0 0 0 2px var(--app);margin-left:-.25rem}
.ocdg-ib{width:2rem;height:2rem;border:0;background:none;border-radius:.5rem;display:inline-grid;place-items:center;color:var(--fg-2);padding:0;flex:none}
.ocdg-ib:hover{background:var(--hover);color:var(--fg)}
.ocdg-ib:disabled{opacity:.4;pointer-events:none}
.ocdg-ib[aria-pressed="true"],.ocdg-ib[aria-expanded="true"]{background:var(--press);color:var(--fg)}
.ocdg-body{flex:1;min-height:0;display:flex}
.ocdg-mid{flex:1;min-width:0;position:relative;display:flex}
.ocdg-mid>.ocbd{position:absolute;inset:0;margin:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column;background:var(--panel)}
.ocdg-mid>.ocbd .ocbd-svg{height:100%;flex:1}
.ocdg-mid>.ocbd>.ocbd-top{display:none}
.ocdg-mid>.ocbd .ocbd-menu{top:.75rem}
.ocdg-side{flex:none;background:var(--app);display:flex;flex-direction:column;min-height:0}
.ocdg-right{width:17.5rem;border-left:1px solid var(--line)}
.ocdg-panel{overflow:auto;flex:1;padding:.75rem 0}
.ocdg-ph{font-size:.8125rem;font-weight:600;margin:0;padding:0 1rem .5rem}
.ocdg-sec{padding:.5rem 1rem .75rem;border-bottom:1px solid var(--line)}
.ocdg-sec:last-child{border-bottom:0}
.ocdg-sh{font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-2);margin:0 0 .5rem}
.ocdg-fld{display:flex;flex-direction:column;gap:.25rem}
.ocdg-lbl{font-size:.75rem;color:var(--fg-2)}
.ocdg-inp{height:2rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg);padding:0 .5rem;font:inherit;font-size:.8125rem;width:100%}
.ocdg-inp:focus{border-color:var(--accent);outline:2px solid var(--accent-ring);outline-offset:0}
.ocdg-hint{font-size:.75rem;color:var(--fg-2);margin:.375rem 0 0}
.ocdg-sw{display:flex;align-items:center;justify-content:space-between;gap:.75rem;width:100%;min-height:2.25rem;border:0;background:none;padding:.25rem 0;text-align:left;font-size:.8125rem;color:var(--fg)}
.ocdg-swt{display:flex;flex-direction:column}
.ocdg-swt .ocdg-hint{margin:0}
.ocdg-tgl{width:1.875rem;height:1.125rem;border-radius:1rem;background:var(--line-2);position:relative;flex:none;transition:background .15s}
.ocdg-tgl::after{content:"";position:absolute;left:2px;top:2px;width:.875rem;height:.875rem;border-radius:50%;background:var(--app);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}
.ocdg-sw[aria-checked="true"] .ocdg-tgl{background:var(--accent)}
.ocdg-sw[aria-checked="true"] .ocdg-tgl::after{transform:translateX(.75rem)}
.ocdg-row{display:flex;align-items:center;justify-content:space-between;min-height:2.25rem;font-size:.8125rem}
.ocdg-row .ocdg-lbl{font-size:.8125rem;color:var(--fg)}
.ocdg-unit{display:inline-flex;align-items:center;gap:.375rem;color:var(--fg-2);font-size:.75rem}
.ocdg-num{width:4rem;height:1.75rem}
.ocdg-seg{display:flex;padding:2px;border-radius:.5rem;background:var(--sunk);gap:2px}
.ocdg-seg button{flex:1;height:1.75rem;border:0;border-radius:.375rem;background:none;font-size:.75rem;color:var(--fg-2);white-space:nowrap;padding:0 .375rem}
.ocdg-seg button[aria-checked="true"]{background:var(--app);color:var(--fg);box-shadow:var(--sh-1)}
.ocdg-rulers{position:absolute;inset:0;pointer-events:none;z-index:1}
.ocdg-rul{position:absolute;background:var(--app);color:var(--fg-2);font-size:.625rem;font-variant-numeric:tabular-nums;overflow:hidden}
.ocdg-rul.h{left:1.25rem;right:0;top:0;height:1.25rem;border-bottom:1px solid var(--line)}
.ocdg-rul.v{top:1.25rem;bottom:0;left:0;width:1.25rem;border-right:1px solid var(--line)}
.ocdg-rul svg{display:block;width:100%;height:100%}
.ocdg-rul text{fill:var(--fg-2);font-family:var(--font)}
.ocdg-rc{position:absolute;left:0;top:0;width:1.25rem;height:1.25rem;background:var(--app);border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.ocdg-left{width:16rem;border-right:1px solid var(--line)}
.ocdg-lp{display:flex;flex-direction:column;min-height:0;flex:1}
.ocdg-search{display:flex;align-items:center;gap:.375rem;margin:.75rem .75rem .5rem;height:2rem;padding:0 .5rem;border:1px solid var(--line-2);border-radius:.5rem;color:var(--fg-2);background:var(--app)}
.ocdg-search:focus-within{border-color:var(--accent);outline:2px solid var(--accent-ring)}
.ocdg-search input{flex:1;min-width:0;border:0;background:none;outline:none;font:inherit;font-size:.8125rem;color:var(--fg)}
.ocdg-search input::-webkit-search-cancel-button{display:none}
.ocdg-search kbd{font-family:var(--font);font-size:.6875rem;color:var(--fg-2);border:1px solid var(--line-2);border-radius:.25rem;padding:0 .3125rem;line-height:1.1rem}
.ocdg-lscroll{overflow:auto;flex:1;padding:0 .5rem .75rem}
.ocdg-lib{margin-top:.25rem}
.ocdg-lh{margin:0;font-size:.75rem;font-weight:600;color:var(--fg-2);padding:.375rem .25rem .25rem}
.ocdg-lh button{display:flex;align-items:center;gap:.375rem;width:100%;height:1.875rem;border:0;background:none;border-radius:.375rem;padding:0 .25rem;font-size:.8125rem;font-weight:600;color:var(--fg)}
.ocdg-lh button:hover{background:var(--hover)}
.ocdg-chev{color:var(--fg-2);transition:transform .15s}
.ocdg-lh button[aria-expanded="true"] .ocdg-chev{transform:rotate(90deg)}
.ocdg-cnt{margin-left:auto;font-weight:500;font-size:.75rem;color:var(--fg-2);font-variant-numeric:tabular-nums}
.ocdg-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:.125rem;padding:.125rem .125rem .25rem}
.ocdg-tile{display:flex;flex-direction:column;align-items:center;gap:.25rem;padding:.4375rem .125rem .375rem;border:0;border-radius:.5rem;background:none;min-width:0;cursor:grab}
.ocdg-tile:hover{background:var(--hover)}
.ocdg-tile.dragging{background:var(--accent-soft);box-shadow:inset 0 0 0 1.5px var(--accent)}
.ocdg-pv{display:block}
.ocdg-tl{font-size:.6875rem;line-height:1.2;color:var(--fg);text-align:center;overflow:hidden;max-width:100%;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;hyphens:auto;-webkit-hyphens:auto;overflow-wrap:anywhere}
.ocdg-tl mark{background:var(--amber-bg);color:inherit;border-radius:2px}
.ocdg-tk{font-size:.625rem;color:var(--fg-2)}
.ocdg-none{padding:1.5rem .75rem;text-align:center;font-size:.8125rem}
.ocdg-none p{margin:0 0 .25rem}
.ocdg-btn{display:inline-flex;align-items:center;gap:.375rem;height:2rem;margin-top:.5rem;padding:0 .75rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);font-size:.8125rem}
.ocdg-btn:hover{background:var(--hover)}
.ocdg-tabs{display:flex;align-items:center;gap:.25rem;padding:.5rem .5rem 0 .75rem}
.ocdg-tabs [role="tablist"]{display:flex;gap:.25rem;flex:1}
.ocdg-tabs [role="tab"]{height:2rem;padding:0 .625rem;border:0;border-radius:.5rem;background:none;font-size:.8125rem;font-weight:500;color:var(--fg-2)}
.ocdg-tabs [role="tab"]:hover{background:var(--hover);color:var(--fg)}
.ocdg-tabs [role="tab"][aria-selected="true"]{background:var(--press);color:var(--fg)}
.ocdg-tp{display:flex;flex-direction:column;flex:1;min-height:0}
.ocdg-lh-plain{display:flex;align-items:center;gap:.375rem;padding:.5rem .5rem .25rem;font-size:.8125rem;color:var(--fg)}
.ocdg-lh{display:flex;align-items:center;gap:.25rem}
.ocdg-beta{position:relative;flex:none;font-size:.625rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:.0625rem .375rem;border-radius:.25rem;background:var(--purple-bg);color:var(--purple-fg);cursor:help}
.ocdg-tip{display:none;position:absolute;right:0;top:calc(100% + .375rem);width:14rem;padding:.5rem .625rem;border-radius:.5rem;background:var(--pop);box-shadow:var(--sh-pop);color:var(--fg);font-size:.75rem;font-weight:400;text-transform:none;letter-spacing:0;line-height:1.4;z-index:5}
.ocdg-beta:hover .ocdg-tip,.ocdg-beta:focus .ocdg-tip{display:block}
.ocdg-lfoot{position:relative;padding:.375rem .5rem;border-top:1px solid var(--line)}
.ocdg-lchoose{display:flex;align-items:center;gap:.375rem;width:100%;height:2rem;padding:0 .5rem;border:0;border-radius:.5rem;background:none;font-size:.8125rem;color:var(--fg)}
.ocdg-lchoose:hover{background:var(--hover)}
.ocdg-chooser{position:absolute;left:.5rem;right:.5rem;bottom:calc(100% + .25rem);padding:.75rem;border-radius:.75rem;background:var(--pop);box-shadow:var(--sh-pop);z-index:6;display:flex;flex-direction:column;gap:.125rem}
.ocdg-chooser .ocdg-hint{margin:0 0 .375rem}
.ocdg-chk{display:flex;align-items:center;gap:.5rem;min-height:2rem;padding:0 .25rem;border-radius:.375rem;font-size:.8125rem;cursor:pointer}
.ocdg-chk:hover{background:var(--hover)}
.ocdg-chk input{margin:0;accent-color:var(--accent)}
.ocdg-beta-s{margin-left:auto}
.ocdg-pad{padding:.5rem .75rem}
.ocdg-left.ocdg-rail{width:3rem;align-items:center;gap:.125rem;padding:.5rem 0;position:relative;overflow:visible}
.ocdg-rsep{width:1.5rem;height:1px;background:var(--line);margin:.25rem 0}
.ocdg-fly{position:absolute;left:calc(100% + .375rem);top:.5rem;width:16rem;max-height:calc(100% - 1rem);display:flex;flex-direction:column;background:var(--pop);border-radius:.75rem;box-shadow:var(--sh-pop);z-index:6;overflow:hidden}
.ocdg-flyh{margin:0;padding:.75rem .75rem 0;font-size:.8125rem;font-weight:600}
.ocdg-btn.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.ocdg-btn.pri:hover{filter:brightness(1.06);background:var(--accent)}
.ocdg-btn:disabled{opacity:.5;cursor:default}
.ocdg-ig{margin:0 0 .125rem .5rem}
.ocdg-igh{margin:0}
.ocdg-igh button{display:flex;align-items:center;gap:.375rem;width:100%;height:1.625rem;border:0;background:none;border-radius:.375rem;padding:0 .25rem;font-size:.75rem;font-weight:500;color:var(--fg-2)}
.ocdg-igh button:hover{background:var(--hover);color:var(--fg)}
.ocdg-igh button[aria-expanded="true"] .ocdg-chev{transform:rotate(90deg)}
.ocdg-ihint{margin:.375rem .25rem 0;font-size:.75rem;line-height:1.45;color:var(--fg-2)}
.ocdg-link{border:0;background:none;padding:0;color:var(--accent);font-size:inherit;text-decoration:underline;text-underline-offset:2px}
.ocdg-link:disabled{color:var(--fg-2);text-decoration:none;cursor:default}
.ocdg-noicon{display:flex;flex-direction:column;align-items:center}
.ocdg-noicon .ocdg-tiles{width:100%;margin-top:.25rem}
.ocdg-ei{color:var(--fg-2);margin-bottom:.375rem}
.ocdg-or{margin-top:.875rem}
@media (max-width:60em){.ocdg-left{width:13.5rem}.ocdg-right{width:15rem}.ocdg-doc{display:none}}
@media (max-width:45em){.ocdg-side{display:none}.ocdg-people{display:none}}
@media (prefers-reduced-motion:reduce){.ocdg *{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

let injected = false;
export function ensureDiagramStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  if (document.querySelector("style[data-ocdg]")) return;
  const s = document.createElement("style");
  s.setAttribute("data-ocdg", "");
  s.textContent = DIAGRAM_CSS;
  document.head.appendChild(s);
}
