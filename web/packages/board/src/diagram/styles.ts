// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Diagram mode styles (DGM-14). Injected once, from the lazy diagram chunk. Tokens only
// (light and dark come from @opencanvas/ui/tokens.css). Units: rem for UI (ADR-050).

export const DIAGRAM_CSS = `
.ocdg{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--app);color:var(--fg);font-family:var(--font);font-size:.875rem;line-height:1.5;-webkit-font-smoothing:antialiased}
.ocdg *{box-sizing:border-box}
:where(.ocdg) :where(button){font:inherit;color:inherit;cursor:pointer}
.ocdg :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
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
@media (max-width:60em){.ocdg-right{width:15rem}.ocdg-doc{display:none}}
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
