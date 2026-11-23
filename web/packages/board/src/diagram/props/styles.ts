// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Properties panel styles (DGM-14 S4, S8). Tokens only; rem for UI (ADR-050).
import { PLACEHOLDER_CSS } from "../Placeholder";
export const PROPS_CSS = `
.ocpp-h{display:flex;flex-direction:column;gap:.125rem}
.ocpp-kind{font-size:.6875rem;font-weight:500;color:var(--fg-2)}
.ocpp-title{font-size:.9375rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocpp-fld{margin-bottom:.5rem}
.ocpp-mono{font-family:var(--mono,ui-monospace,monospace)}
.ocpp-count{margin-left:.375rem;color:var(--fg-3,var(--fg-2));font-weight:500}
.ocpp-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.25rem}
.ocpp-row{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem;padding:.125rem;border-radius:.375rem}
.ocpp-row:focus-within{background:var(--hover)}
.ocpp-grip{color:var(--fg-4,var(--fg-2));cursor:grab;display:inline-grid;place-items:center;width:1rem}
.ocpp-vis,.ocpp-key{height:1.75rem;min-width:2rem;border:1px solid var(--line-2);border-radius:.375rem;background:var(--app);color:var(--fg);font:inherit;font-size:.75rem;padding:0 .25rem}
.ocpp-key[data-key="pk"]{color:var(--amber,#b26b00);font-weight:600}
.ocpp-key[data-key="fk"]{color:var(--accent);font-weight:600}
.ocpp-cell{height:1.75rem;width:4.5rem;min-width:0;border:1px solid transparent;border-radius:.375rem;background:none;color:var(--fg);font:inherit;font-size:.8125rem;padding:0 .375rem}
.ocpp-cell.w{flex:1;width:auto}
.ocpp-cell:hover{border-color:var(--line-2)}
.ocpp-cell:focus{border-color:var(--accent);outline:none;background:var(--app)}
.ocpp-del{width:1.5rem;height:1.5rem;opacity:.6}
.ocpp-row:hover .ocpp-del{opacity:1}
.ocpp-sub{display:flex;flex-wrap:wrap;gap:.375rem;align-items:center;width:100%;padding-left:2.25rem}
.ocpp-sub:empty{display:none}
.ocpp-cb{display:inline-flex;align-items:center;gap:.25rem;font-size:.75rem;color:var(--fg-2)}
.ocpp-add{display:inline-flex;align-items:center;gap:.375rem;margin-top:.375rem;height:1.75rem;padding:0 .5rem;border:0;border-radius:.375rem;background:none;color:var(--accent);font-size:.8125rem}
.ocpp-add:hover{background:var(--hover)}
.ocpp-list{list-style:none;margin:0;padding:0}
.ocpp-list li{display:flex;justify-content:space-between;gap:.5rem;padding:.25rem 0;font-size:.8125rem}
.ocpp-dim{color:var(--fg-2);font-size:.75rem}
.ocpp-ends{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem;margin:0;font-size:.8125rem}
.ocpp-ends dt{color:var(--fg-2)}
.ocpp-ends dd{margin:0}
.ocpp .ocdg-seg{margin-bottom:.5rem}
.ocpp-xywh{display:grid;grid-template-columns:1fr 1fr;gap:0 .5rem}
.ocpp .ocdg-sw:disabled{cursor:default;opacity:.8}
`;

let injected = false;
export function ensurePropsStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  if (document.querySelector("style[data-ocpp]")) return;
  const s = document.createElement("style");
  s.setAttribute("data-ocpp", "");
  s.textContent = PROPS_CSS + PLACEHOLDER_CSS;
  document.head.appendChild(s);
}
