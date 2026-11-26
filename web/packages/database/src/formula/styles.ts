// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Styles for formula, relation and rollup fields (prototype frames 1-5), tokens only.

export const ADV_CSS = `
.ocdb-ferr{font-family:var(--mono);font-size:.75rem;font-weight:600;color:var(--red-fg);position:relative;border-radius:.25rem;padding:0 .125rem;cursor:help}
.ocdb-ferr:hover::after,.ocdb-ferr:focus-visible::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + .25rem);z-index:5;background:var(--pop);color:var(--fg);box-shadow:var(--sh-pop);border-radius:.5rem;padding:.375rem .5rem;font-family:var(--font);font-weight:400;font-size:.75rem;width:max-content;max-width:16rem;white-space:normal}
.ocdb-dash{color:var(--fg-4)}
.ocdb-fbool{display:inline-grid;place-items:center;width:1rem;height:1rem;border-radius:.25rem;border:1px solid var(--line-2);color:var(--accent-fg)}
.ocdb-fbool.on{background:var(--accent);border-color:var(--accent)}
.ocdb-rel{background:var(--hover);color:var(--fg)}
.ocdb-noacc,.ocdb-gone{background:var(--sunk);color:var(--fg-3)}
.ocdb-more{font-size:.75rem;color:var(--fg-3)}
.ocdb-skip{margin-left:.375rem;font-size:.6875rem;color:var(--fg-3);font-weight:400}
.ocdb-comp{display:flex;align-items:center;gap:.25rem;min-width:0;overflow:hidden;padding:0 .5rem;height:100%}
.ocdb-comp.num{justify-content:flex-end;font-variant-numeric:tabular-nums}
.ocdb-banner{display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;margin:.25rem 0 .5rem;border-radius:.5rem;background:var(--amber-bg);font-size:.8125rem}
.ocdb-banner .ocdb-btn{margin-left:auto}
.ocdb-fx{display:flex;flex-direction:column;gap:.5rem;padding:.75rem;width:min(30rem,calc(100vw - 2rem))}
.ocdb-fx-h{font-size:.8125rem;font-weight:600}
.ocdb-fx-code{position:relative;font-family:var(--mono);font-size:.8125rem;line-height:1.5}
.ocdb-fx-code pre,.ocdb-fx-code textarea{margin:0;padding:.5rem .625rem;border-radius:.5rem;white-space:pre-wrap;word-break:break-word;min-height:4.5rem;font:inherit;width:100%}
.ocdb-fx-code pre{position:absolute;inset:0;pointer-events:none;border:1px solid transparent;color:var(--fg)}
.ocdb-fx-code textarea{position:relative;display:block;resize:vertical;border:1px solid var(--line-2);background:transparent;color:transparent;caret-color:var(--fg);outline:none}
.ocdb-fx-code textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.ocdb-fx-code .t-fn{color:var(--purple-fg);font-weight:600}
.ocdb-fx-code .t-str{color:var(--accent)}
.ocdb-fx-code .t-num{color:var(--amber-fg,var(--fg))}
.ocdb-fx-code .t-op{color:var(--fg-3)}
.ocdb-fx-code mark{background:none;color:inherit;text-decoration:wavy underline var(--red-fg);text-underline-offset:.2em}
.ocdb-fx-meta{display:flex;align-items:center;gap:.5rem;font-size:.75rem;color:var(--fg-3);flex-wrap:wrap}
.ocdb-fx-type{padding:0 .375rem;border-radius:.25rem;background:var(--hover);color:var(--fg-2);font-weight:500}
.ocdb-fx-err{font-size:.75rem;color:var(--red-fg)}
.ocdb-fx-err b{font-family:var(--mono)}
.ocdb-fx-sig{font-family:var(--mono);font-size:.75rem;color:var(--fg-2);background:var(--sunk);border-radius:.375rem;padding:.25rem .5rem}
.ocdb-fx-ac{list-style:none;margin:0;padding:.25rem;border:1px solid var(--line);border-radius:.5rem;max-height:12rem;overflow:auto;background:var(--pop)}
.ocdb-fx-ac li{display:flex;gap:.5rem;align-items:baseline;padding:.25rem .5rem;border-radius:.375rem;cursor:pointer;font-size:.8125rem}
.ocdb-fx-ac li[aria-selected=true]{background:var(--accent-soft)}
.ocdb-fx-ac code{font-family:var(--mono);font-weight:600}
.ocdb-fx-ac span{color:var(--fg-3);font-size:.75rem}
.ocdb-fx-chips{display:flex;gap:.375rem;overflow-x:auto;padding-bottom:.125rem}
.ocdb-fx-chips button{flex:none;min-height:2.75rem;padding:0 .75rem;border-radius:.5rem;border:1px solid var(--line-2);background:var(--panel);font-family:var(--mono);font-size:.8125rem}
.ocdb-fx-ft{display:flex;align-items:center;gap:.5rem;justify-content:flex-end}
.ocdb-fx-ft .ocdb-hintk{margin-right:auto}
.ocdb-rp{display:flex;flex-direction:column;width:min(20rem,calc(100vw - 2rem))}
.ocdb-rp ul{list-style:none;margin:0;padding:.25rem;max-height:16rem;overflow:auto}
.ocdb-rp li button{display:flex;align-items:center;gap:.5rem;width:100%;border:0;background:none;text-align:left;padding:.375rem .5rem;border-radius:.375rem;min-height:2.25rem}
.ocdb-compact .ocdb-rp li button,.ocdb-layer.compact .ocdb-rp li button{min-height:2.75rem}
.ocdb-rp li button:hover,.ocdb-rp li button:focus-visible{background:var(--hover)}
.ocdb-rp li .ck{width:1rem;flex:none;color:var(--accent)}
.ocdb-rp li .sub{margin-left:auto;color:var(--fg-3);font-size:.75rem}
.ocdb-setup{display:flex;flex-direction:column;gap:.625rem;padding:.75rem;width:min(24rem,calc(100vw - 2rem))}
.ocdb-setup label{display:flex;flex-direction:column;gap:.25rem;font-size:.75rem;color:var(--fg-3)}
.ocdb-setup select{font:inherit;font-size:.8125rem;padding:.375rem .5rem;border-radius:.375rem;border:1px solid var(--line-2);background:var(--panel);color:var(--fg)}
.ocdb-setup .grp{font-size:.6875rem;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-4);margin-top:.25rem}
.ocdb-setup .dbs{display:flex;flex-direction:column;gap:2px}
.ocdb-setup .dbs button{display:flex;align-items:center;gap:.5rem;border:1px solid transparent;background:none;border-radius:.375rem;padding:.375rem .5rem;text-align:left}
.ocdb-setup .dbs button[aria-checked=true]{border-color:var(--accent);background:var(--accent-soft)}
.ocdb-setup .dbs .sub{margin-left:auto;color:var(--fg-3);font-size:.75rem}
.ocdb-setup .seg{display:inline-flex;border:1px solid var(--line-2);border-radius:.5rem;padding:2px;align-self:flex-start}
.ocdb-setup .seg button{border:0;background:none;padding:.25rem .75rem;border-radius:.375rem;font-size:.8125rem}
.ocdb-setup .seg button[aria-checked=true]{background:var(--hover);font-weight:600}
.ocdb-setup .note{font-size:.75rem;color:var(--fg-3);margin:0}
.ocdb-setup .row3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}
@media (max-width:40em){.ocdb-setup .row3{grid-template-columns:1fr}}
`;
