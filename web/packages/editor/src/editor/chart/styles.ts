// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The linked chart block's styles (prototype `.ss-chart`, frame 4h): theme tokens, rem units.
const CSS = `
.occh{position:relative;border:1px solid var(--line);border-radius:.875rem;background:var(--app);box-shadow:var(--sh-card);padding:.75rem .875rem .875rem;margin:.25rem 0;color:var(--fg)}
.occh-hd{display:flex;align-items:center;gap:.375rem;min-height:2rem}
.occh-hd b{font-weight:600;font-size:.9375rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.occh-sub{color:var(--fg-3);font-size:.75rem;white-space:nowrap}
.occh-grow{flex:1}
.occh-ib{display:inline-grid;place-items:center;width:2rem;height:2rem;border:0;border-radius:.5rem;background:transparent;color:var(--fg-2);cursor:pointer}
.occh-ib:hover{background:var(--hover);color:var(--fg)}
.occh-ib[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}
.occh-ib:focus-visible,.occh button:focus-visible,.occh input:focus-visible,.occh select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.occh-body{display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap}
.occh-plot{flex:1 1 18rem;min-width:0}
.occh svg{display:block;width:100%;height:auto;overflow:visible}
.occh svg text{fill:var(--fg-3);font-size:.6875rem;font-family:inherit}
.occh svg .v{fill:var(--fg-2)}
.occh svg .ax{fill:var(--fg-2);font-weight:500}
.occh-empty{display:grid;place-items:center;min-height:9rem;color:var(--fg-3);font-size:.875rem;text-align:center;padding:1rem}
.occh-leg{display:flex;flex-wrap:wrap;gap:.25rem .875rem;list-style:none;margin:.5rem 0 0;padding:0;font-size:.8125rem;color:var(--fg-2)}
.occh-leg li{display:flex;align-items:center;gap:.375rem}
.occh-leg i{width:.625rem;height:.625rem;border-radius:.1875rem;flex:none}
.occh-tbl{margin-top:.625rem;max-height:16rem;overflow:auto;border:1px solid var(--line);border-radius:.5rem}
.occh-tbl table{border-collapse:collapse;width:100%;font-size:.8125rem}
.occh-tbl th,.occh-tbl td{padding:.3125rem .625rem;border-bottom:1px solid var(--line);text-align:left}
.occh-tbl td+td,.occh-tbl th+th{text-align:right;font-variant-numeric:tabular-nums}
.occh-tbl caption{text-align:left;padding:.375rem .625rem;color:var(--fg-3);font-size:.75rem}
.occh-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.occh-panel{flex:0 1 16.5rem;min-width:13rem;display:grid;gap:.75rem;padding:.75rem;border:1px solid var(--line);border-radius:.75rem;background:var(--panel);font-size:.8125rem}
.occh-panel h3{margin:0;font-size:.8125rem;font-weight:600}
.occh-panel label{display:grid;gap:.25rem;color:var(--fg-2)}
.occh-panel input[type=text],.occh-panel select{height:2rem;padding:0 .5rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg);font:inherit;min-width:0}
.occh-panel .chk{display:flex;align-items:center;gap:.5rem}
.occh-kinds{display:grid;grid-template-columns:repeat(6,1fr);gap:.25rem}
.occh-kinds button{display:grid;place-items:center;height:2.125rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg-2);cursor:pointer}
.occh-kinds button[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.occh-row2{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.occh-done{justify-self:end;height:2rem;padding:0 .875rem;border:0;border-radius:.5rem;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer}
.occh-err{color:var(--red-fg)}
.occh-link{display:flex;align-items:center;gap:.5rem;margin:.25rem 0 .375rem;padding:.4375rem .75rem;border-radius:.625rem;background:var(--accent-soft);color:var(--fg-2);font-size:.8125rem}
.occh-link svg{color:var(--accent);flex:none}
@media (max-width:45em){.occh-panel{flex-basis:100%}}
`;

let done = false;
export function injectChartCss() {
  if (done || typeof document === "undefined") return;
  done = true;
  const s = document.createElement("style");
  s.setAttribute("data-occh", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
