// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Styles of the icon dialogs (DGM-17). Self-contained (they also open outside diagram mode, from
// the paste toast), tokens only so light and dark both work, rem for type and spacing (ADR-050).

const CSS = `
.ocic-scrim{position:fixed;inset:0;z-index:1100;display:grid;place-items:center;padding:1rem;background:rgba(10,10,15,.36);font-family:var(--font);font-size:.875rem;line-height:1.5;color:var(--fg)}
.ocic-scrim.ocic-top{z-index:1110}
.ocic-scrim *{box-sizing:border-box}
.ocic-scrim :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ocic-dlg{width:min(34rem,100%);max-height:calc(100vh - 2rem);display:flex;flex-direction:column;background:var(--pop);color:var(--fg);border-radius:.875rem;box-shadow:var(--sh-pop);padding:0}
.ocic-dlg.wide{width:min(46rem,100%)}
.ocic-dlg.ocic-confirm{width:min(27rem,100%)}
.ocic-dlg .ocdg-dh{display:flex;align-items:center;gap:.5rem;padding:.875rem 1rem .5rem 1.25rem}
.ocic-dlg .ocdg-dh h2{flex:1;margin:0;font-size:1rem;font-weight:600}
.ocic-body{padding:.25rem 1.25rem .75rem;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:.75rem}
.ocic-body p{margin:0}
.ocic-dlg .ocdg-df{display:flex;align-items:center;justify-content:flex-end;gap:.5rem;padding:.75rem 1.25rem;border-top:1px solid var(--line)}
.ocic-sp{margin-right:auto}
.ocic-dlg .ocdg-ib{width:2rem;height:2rem;border:0;background:none;border-radius:.5rem;display:inline-grid;place-items:center;color:var(--fg-2);padding:0;cursor:pointer}
.ocic-dlg .ocdg-ib:hover{background:var(--hover);color:var(--fg)}
.ocic-dlg .ocdg-pri,.ocic-dlg .ocdg-sec-b{display:inline-flex;align-items:center;gap:.375rem;height:2rem;padding:0 .875rem;border-radius:.5rem;font:inherit;font-size:.8125rem;font-weight:500;cursor:pointer;white-space:nowrap}
.ocic-dlg .ocdg-pri{border:0;background:var(--accent);color:var(--accent-fg)}
.ocic-dlg .ocdg-pri:disabled{opacity:.5;cursor:default}
.ocic-dlg .ocdg-sec-b{border:1px solid var(--line-2);background:var(--app);color:var(--fg)}
.ocic-dlg .ocdg-sec-b:hover{background:var(--hover)}
.ocic-dlg .ocic-danger{background:var(--red-fg)}
.ocic-dlg .ocdg-hint{font-size:.75rem;color:var(--fg-2)}
.ocic-dlg .ocdg-sh{margin:0;font-size:.8125rem;font-weight:600}
.ocic-dlg .ocdg-err{margin:0;color:var(--red-fg);font-size:.8125rem}
.ocic-dlg .ocdg-fld{display:flex;flex-direction:column;gap:.25rem;flex:1;min-width:0}
.ocic-dlg .ocdg-lbl{font-size:.75rem;color:var(--fg-2)}
.ocic-dlg .ocdg-inp{height:2rem;border:1px solid var(--line-2);border-radius:.5rem;background:var(--app);color:var(--fg);padding:0 .5rem;font:inherit;font-size:.8125rem;width:100%;min-width:0}
.ocic-dlg .ocdg-inp:focus{border-color:var(--accent);outline:2px solid var(--accent-ring);outline-offset:0}
.ocic-dlg .ocdg-items{list-style:none;margin:.375rem 0 0;padding:0;display:flex;flex-direction:column;gap:.25rem}
.ocic-dlg .ocdg-item{display:flex;align-items:center;gap:.5rem;font-size:.8125rem}
.ocic-dlg .ocdg-it{flex:1}
.ocic-dlg .ocdg-cnt{font-size:.75rem;color:var(--fg-2);font-variant-numeric:tabular-nums}
.ocic-drop{display:flex;flex-direction:column;align-items:center;gap:.375rem;padding:1.5rem 1rem;border:1.5px dashed var(--line-2);border-radius:.75rem;background:var(--sunk);color:var(--fg-2);text-align:center}
.ocic-drop.over{border-color:var(--accent);background:var(--accent-soft)}
.ocic-drop b{color:var(--fg)}
.ocic-or{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;justify-content:center}
.ocic-or .ocdg-hint{display:inline-flex;align-items:center;gap:.25rem}
.ocic-lims{display:flex;flex-wrap:wrap;gap:.375rem;list-style:none;margin:0;padding:0}
.ocic-lims li{font-size:.75rem;color:var(--fg-2);padding:.125rem .5rem;border-radius:1rem;background:var(--sunk)}
.ocic-note{font-size:.75rem;color:var(--fg-2)}
.ocic-file{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;color:var(--fg-2)}
.ocic-fn{font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:14rem}
.ocic-file .ocdg-sec-b{margin-left:auto}
.ocic-pvs{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.ocic-pvrow{display:flex;align-items:center;gap:.75rem;padding:.75rem;border-radius:.625rem;border:1px solid var(--line)}
.ocic-pvrow[data-theme-pv="light"]{background:#ffffff}
.ocic-pvrow[data-theme-pv="light"] .ocdg-hint{color:#55555e}
.ocic-pvrow[data-theme-pv="dark"]{background:#141417}
.ocic-pvrow[data-theme-pv="dark"] .ocdg-hint{color:#a9a9b4}
.ocic-pvrow .ocdg-hint{min-width:2.25rem}
.ocic-pvrow img{display:block;object-fit:contain}
.ocic-ok{display:flex;align-items:center;gap:.375rem;color:var(--green-fg);font-size:.8125rem}
.ocic-report{padding:.75rem;border-radius:.625rem;background:var(--sunk)}
.ocic-fields{display:flex;gap:.75rem;flex-wrap:wrap}
.ocic-refused{display:flex;gap:.5rem;padding:.75rem;border-radius:.625rem;background:var(--amber-bg);color:var(--amber-fg)}
.ocic-refused p{color:var(--fg)}
.ocic-reasons{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.375rem}
.ocic-reasons li{display:flex;flex-direction:column;font-size:.8125rem}
.ocic-mtop{display:flex;gap:.5rem;align-items:center}
.ocic-filter{flex:1;display:flex;align-items:center;gap:.375rem;height:2rem;padding:0 .5rem;border:1px solid var(--line-2);border-radius:.5rem;color:var(--fg-2);background:var(--app)}
.ocic-filter input{flex:1;min-width:0;border:0;background:none;outline:none;font:inherit;font-size:.8125rem;color:var(--fg)}
.ocic-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ocic-row{display:grid;grid-template-columns:2rem minmax(0,1fr) auto auto auto auto;align-items:center;gap:.75rem;padding:.5rem 0;border-bottom:1px solid var(--line);position:relative}
.ocic-th{width:2rem;height:2rem;border-radius:.5rem;object-fit:contain;background:var(--sunk);border:1px dashed var(--line-2)}
.ocic-t{display:flex;flex-direction:column;min-width:0}
.ocic-t b,.ocic-t span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocic-edit{display:flex;gap:.375rem;flex-wrap:wrap;min-width:0}
.ocic-acts{display:flex;gap:.125rem;position:relative}
.ocic-menu{position:absolute;right:0;top:calc(100% + .25rem);z-index:2;display:flex;flex-direction:column;min-width:15rem;padding:.25rem;border-radius:.625rem;background:var(--pop);box-shadow:var(--sh-pop)}
.ocic-menu button{display:flex;align-items:center;gap:.5rem;height:2rem;padding:0 .5rem;border:0;border-radius:.375rem;background:none;color:var(--fg);font:inherit;font-size:.8125rem;text-align:left;cursor:pointer}
.ocic-menu button:hover{background:var(--hover)}
.ocic-meter{height:.375rem;border-radius:1rem;background:var(--sunk);overflow:hidden}
.ocic-meter i{display:block;height:100%;background:var(--accent)}
@media (max-width:30em){
  .ocic-scrim{padding:0;align-items:end}
  .ocic-dlg,.ocic-dlg.wide{width:100%;max-height:100vh;border-radius:.875rem .875rem 0 0}
  .ocic-pvs{grid-template-columns:1fr}
  .ocic-row{grid-template-columns:2rem minmax(0,1fr) auto;row-gap:.125rem}
  .ocic-row .ocdg-hint:not(.ocic-by){grid-column:2}
  .ocic-by{display:none}
  .ocic-dlg .ocdg-pri,.ocic-dlg .ocdg-sec-b,.ocic-dlg .ocdg-ib{min-height:2.75rem}
  .ocic-dlg .ocdg-ib{width:2.75rem}
  .ocic-dlg .ocdg-df{flex-wrap:wrap}
}
`;

let injected = false;
export function ensureIconStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-ocic", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
