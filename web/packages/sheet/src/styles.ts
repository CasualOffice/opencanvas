// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Styles for the Spreadsheet block (prototype v04-approved/spreadsheet.html, `.ss-*`). Injected
// once into document.head on first mount. Design tokens only, so light and dark come free.

export const CSS = `
.ocsh,.ocsh-full{font-family:var(--font);color:var(--fg);font-size:.875rem;line-height:1.4;-webkit-font-smoothing:antialiased}
.ocsh *,.ocsh-full *{box-sizing:border-box}
:where(.ocsh,.ocsh-full,.ocsh-pop) :where(button,input){font:inherit;color:inherit;letter-spacing:inherit}
:where(.ocsh,.ocsh-full,.ocsh-pop) :where(button){cursor:pointer;-webkit-tap-highlight-color:transparent}
.ocsh :focus-visible,.ocsh-full :focus-visible,.ocsh-pop :focus-visible{outline:2px solid var(--accent-ring);outline-offset:1px}
.ocsh svg.lucide,.ocsh-full svg.lucide,.ocsh-pop svg.lucide{flex:none;display:block}

.ocsh{border-radius:.75rem;box-shadow:inset 0 0 0 1px var(--line);background:var(--app);overflow:hidden;margin:.5rem 0 1rem;display:flex;flex-direction:column;position:relative}
.ocsh.flash{box-shadow:inset 0 0 0 2px var(--accent)}
.ocsh-full{position:fixed;inset:0;z-index:200;background:var(--app);display:flex;flex-direction:column}
.ocsh-h{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem;min-height:2.5rem;padding:.25rem .375rem .25rem .625rem;min-width:0}
.ocsh-hi{width:1.5rem;height:1.5rem;border-radius:.4375rem;display:grid;place-items:center;flex:none;background:var(--green-bg);color:var(--green-fg)}
.ocsh-hn{font-weight:600;font-size:.9375rem;white-space:nowrap}
.ocsh-grow{flex:1;min-width:0}
.ocsh-ib{width:1.875rem;height:1.875rem;border:0;background:none;border-radius:.375rem;display:inline-grid;place-items:center;color:var(--fg-2);flex:none;padding:0;position:relative}
.ocsh-ib:hover{background:var(--hover);color:var(--fg)}
.ocsh-ib[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}
.ocsh-ib:disabled{opacity:.4;cursor:default;background:none}
.ocsh-ib.hot{background:var(--accent-soft);color:var(--accent)}
.ocsh-ib .bar{position:absolute;left:.4375rem;right:.4375rem;bottom:.25rem;height:.1875rem;border-radius:1px}
.ocsh-btn{height:2rem;padding:0 .75rem;border-radius:.5rem;display:inline-flex;align-items:center;justify-content:center;gap:.4375rem;font-size:.8125rem;font-weight:500;background:var(--app);color:var(--fg);border:0;box-shadow:inset 0 0 0 1px var(--line-2);white-space:nowrap;flex:none}
.ocsh-btn:hover{background:var(--hover)}
.ocsh-btn.p{background:var(--accent);color:var(--accent-fg,#fff);box-shadow:none}
.ocsh-tt{font-weight:600;font-size:.9375rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* toolbar (full screen) */
.ocsh-tb{display:flex;align-items:center;gap:.125rem;min-height:2.5rem;margin:0 .5rem .375rem;padding:.125rem .375rem;border-radius:1.25rem;background:var(--panel);flex:none;box-shadow:inset 0 0 0 1px var(--line);flex-wrap:wrap}
.ocsh-tbs{width:1px;height:1.25rem;background:var(--line-2);margin:0 .25rem;flex:none}
.ocsh-tbt{height:1.875rem;padding:0 .4375rem;border:0;background:none;border-radius:.375rem;display:inline-flex;align-items:center;gap:.25rem;font-size:.75rem;color:var(--fg-2);white-space:nowrap}
.ocsh-tbt:hover{background:var(--hover);color:var(--fg)}

/* tabs */
.ocsh-tabs{display:flex;gap:.125rem;align-items:center;min-width:0;overflow-x:auto;scrollbar-width:none}
.ocsh-tabs::-webkit-scrollbar{display:none}
.ocsh-tab{display:inline-flex;align-items:center;gap:.25rem;height:1.75rem;padding:0 .625rem;border:0;border-radius:.375rem;background:none;color:var(--fg-2);font-size:.8125rem;white-space:nowrap;flex:none}
.ocsh-tab:hover{background:var(--hover);color:var(--fg)}
.ocsh-tab[aria-selected="true"]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.ocsh-tabin{height:1.75rem;width:8rem;border:0;border-radius:.375rem;padding:0 .5rem;box-shadow:inset 0 0 0 2px var(--accent);background:var(--app);outline:none;font-size:.8125rem}
.ocsh-sb{display:flex;align-items:center;gap:.25rem;min-height:2.5rem;padding:.25rem .5rem;border-top:1px solid var(--line);background:var(--panel);font-size:.75rem;color:var(--fg-2);flex:none;flex-wrap:wrap}
.ocsh-agg{display:flex;gap:.75rem;align-items:center;padding:0 .5rem;height:1.75rem;border-radius:.375rem;box-shadow:inset 0 0 0 1px var(--line-2);background:var(--app);margin-left:auto;white-space:nowrap}
.ocsh-agg b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums;margin-left:.25rem}

/* formula bar */
.ocsh-fx{display:flex;align-items:center;gap:.5rem;height:2.125rem;padding:0 .75rem;border-top:1px solid var(--line);border-bottom:1px solid var(--line-2);background:var(--app);flex:none;min-width:0}
.ocsh.compact .ocsh-fx{height:1.875rem;background:var(--panel)}
.ocsh-nb{font-size:.75rem;font-weight:500;padding:0 .375rem;height:1.5rem;width:6.5rem;flex:none;border:0;border-radius:.25rem;box-shadow:inset 0 0 0 1px var(--line-2);background:var(--app)}
.ocsh-fxi{color:var(--fg-2);display:inline-flex;padding:0 .5rem;border-left:1px solid var(--line-2);border-right:1px solid var(--line-2);font-family:Georgia,serif;font-style:italic;flex:none}
.ocsh-fxv{flex:1;min-width:0;height:100%;border:0;background:none;outline:none;font-family:var(--mono);font-size:.8125rem;padding:0}
.ocsh-fxv:read-only{color:var(--fg-2)}

/* grid */
.ocsh-grid{position:relative;overflow:auto;overscroll-behavior:contain;font-size:.8125rem;background:var(--app);outline:none;flex:none;height:20rem}
.ocsh-full .ocsh-grid{flex:1;height:auto;min-height:0}
.ocsh-grid:focus-visible{box-shadow:inset 0 0 0 2px var(--accent-ring)}
.ocsh-pane{position:absolute;overflow:hidden}
.ocsh-in{position:absolute;left:0;top:0;will-change:transform}
.ocsh-row{display:contents}
.ocsh-c{position:absolute;display:flex;align-items:center;gap:.375rem;padding:0 .375rem;border-right:1px solid var(--line);border-bottom:1px solid var(--line);white-space:nowrap;overflow:visible;background:var(--app);user-select:none}
.ocsh-c.n{justify-content:flex-end;font-variant-numeric:tabular-nums}
.ocsh-c.al-l{justify-content:flex-start}.ocsh-c.al-c{justify-content:center}.ocsh-c.al-r{justify-content:flex-end}
.ocsh-c.b{font-weight:600}.ocsh-c.i{font-style:italic}.ocsh-c.st{text-decoration:line-through}
.ocsh-c.err{color:var(--red-fg);font-weight:600}
.ocsh-c.err::before{content:"";position:absolute;top:0;right:0;border-top:.4375rem solid var(--red-fg);border-left:.4375rem solid transparent}
.ocsh-c.rs{background:color-mix(in srgb,var(--accent) 12%,var(--app))}
.ocsh-c::after{content:"";position:absolute;inset:-1px 0 0 -1px;pointer-events:none;border:0 solid var(--accent)}
.ocsh-c.act::after{border-width:2px}
.ocsh-c.et::after{border-top-width:2px}.ocsh-c.eb::after{border-bottom-width:2px}.ocsh-c.el::after{border-left-width:2px}.ocsh-c.er::after{border-right-width:2px}
.ocsh-c.fp{box-shadow:inset 0 0 0 1px var(--fg-2)}
.ocsh-c.fzr{border-bottom:2px solid var(--line-2)}.ocsh-c.fzc{border-right:2px solid var(--line-2)}
.ocsh-c.ed{overflow:visible;z-index:4;padding:0}
.ocsh-ce{position:absolute;left:0;top:0;min-width:100%;height:100%;border:0;outline:none;padding:0 .375rem;background:var(--app);box-shadow:inset 0 0 0 2px var(--accent),var(--sh-pop);font:inherit;font-family:var(--mono);font-size:.8125rem;color:var(--fg)}
.ocsh-fh{position:absolute;right:-.0625rem;bottom:-.0625rem;width:.5rem;height:.5rem;background:var(--accent);box-shadow:0 0 0 2px var(--app);z-index:3;cursor:crosshair;touch-action:none}
.ocsh-flt{display:inline-grid;place-items:center;width:1.25rem;height:1.25rem;border:0;border-radius:.25rem;background:none;color:var(--fg-2);margin-left:auto;flex:none;padding:0}
.ocsh-flt:hover,.ocsh-flt.on{background:var(--accent-soft);color:var(--accent)}
.ocsh-ct{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ocsh-c.n .ocsh-ct,.ocsh-c.al-r .ocsh-ct{text-align:right}.ocsh-c.al-c .ocsh-ct{text-align:center}

/* headers */
.ocsh-h1{position:absolute;display:flex;align-items:center;justify-content:center;color:var(--fg-2);font-size:.75rem;background:var(--panel);border-right:1px solid var(--line);border-bottom:1px solid var(--line-2);user-select:none;font-variant-numeric:tabular-nums;cursor:default}
.ocsh-h1.rh{font-size:.6875rem;border-right:1px solid var(--line-2);border-bottom:1px solid var(--line)}
.ocsh-h1.hl{background:var(--accent-soft);color:var(--fg);font-weight:600}
.ocsh-h1.all{background:var(--accent);color:var(--accent-fg,#fff)}
.ocsh-corner{position:absolute;left:0;top:0;background:var(--panel);border-right:1px solid var(--line-2);border-bottom:1px solid var(--line-2);z-index:3;border:0;padding:0}
.ocsh-rz{position:absolute;z-index:2;touch-action:none}
.ocsh-rz.v{right:-.1875rem;top:0;bottom:0;width:.375rem;cursor:col-resize}
.ocsh-rz.h{bottom:-.1875rem;left:0;right:0;height:.375rem;cursor:row-resize}
.ocsh-rz:hover,.ocsh-rz.on{background:var(--accent)}
.ocsh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* menus and popovers */
.ocsh-pop{position:fixed;z-index:400;background:var(--pop);color:var(--fg);border-radius:.625rem;box-shadow:var(--sh-pop);padding:.25rem;min-width:13rem;max-width:calc(100vw - 1rem);max-height:calc(100vh - 1rem);overflow:auto;font-family:var(--font);font-size:.8125rem}
.ocsh-mi{display:flex;align-items:center;gap:.625rem;width:100%;min-height:2rem;padding:0 .625rem;border:0;border-radius:.375rem;background:none;text-align:left;white-space:nowrap;color:var(--fg)}
.ocsh-mi:hover,.ocsh-mi:focus-visible{background:var(--hover);outline:none}
.ocsh-mi.dan{color:var(--red-fg)}
.ocsh-mi small{margin-left:auto;color:var(--fg-3);padding-left:1rem;font-size:.75rem}
.ocsh-msep{height:1px;background:var(--line);margin:.25rem .375rem}
.ocsh-fv{display:flex;flex-direction:column;gap:.125rem;max-height:14rem;overflow:auto;padding:.25rem .375rem}
.ocsh-fv label{display:flex;gap:.5rem;align-items:center;min-height:1.75rem}
.ocsh-fact{display:flex;justify-content:flex-end;gap:.375rem;padding:.375rem}
.ocsh-sw{display:flex;gap:.375rem;padding:.375rem .5rem;flex-wrap:wrap}
.ocsh-sw button{width:1.375rem;height:1.375rem;border-radius:50%;border:0;box-shadow:inset 0 0 0 1px var(--line-2);padding:0}
.ocsh-note{position:absolute;left:50%;bottom:3rem;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;max-width:calc(100% - 1rem);padding:.5rem .5rem .5rem .75rem;border-radius:.625rem;background:var(--pop);box-shadow:var(--sh-pop);font-size:.8125rem}
.ocsh-note .ocsh-btn{height:1.75rem}
.ocsh-load{display:grid;place-items:center;height:20rem;color:var(--fg-3);font-size:.8125rem}
/* merges, wrap, find, hidden, moves, tabs (SHEET-07) */
.ocsh-c.mg{z-index:1}
.ocsh-h1.drop{box-shadow:inset 2px 0 0 var(--accent)}.ocsh-h1.rh.drop{box-shadow:inset 0 2px 0 var(--accent)}
.ocsh-c.wr{white-space:normal;line-height:1.2;align-items:flex-start;padding-top:.1875rem}
.ocsh-c.wr .ocsh-ct{white-space:normal;overflow-wrap:anywhere}
.ocsh-c.fm{outline:2px dashed var(--amber-fg);outline-offset:-2px}
.ocsh-unh{position:absolute;z-index:3;display:grid;place-items:center;width:.875rem;height:.875rem;padding:0;border:0;border-radius:.1875rem;background:var(--app);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2)}
.ocsh-unh.v{left:-.4375rem;top:.3125rem}.ocsh-unh.h{top:-.4375rem;left:.25rem}
.ocsh-tab{position:relative}
.ocsh-tc{position:absolute;left:.5rem;right:.5rem;bottom:0;height:.1875rem;border-radius:2px}
.ocsh-tdrop{position:absolute;left:-.125rem;top:.125rem;bottom:.125rem;width:2px;background:var(--accent)}
.ocsh-find{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem .625rem;padding:.375rem .75rem;border-bottom:1px solid var(--line);background:var(--panel);font-size:.8125rem;flex:none}
.ocsh-find input[type=text],.ocsh-find input:not([type]){height:1.75rem;width:11rem;max-width:100%;border:0;border-radius:.375rem;padding:0 .5rem;box-shadow:inset 0 0 0 1px var(--line-2);background:var(--app)}
.ocsh-find label{display:inline-flex;align-items:center;gap:.25rem;white-space:nowrap}
.ocsh-fcount{color:var(--fg-3);min-width:4rem}
.ocsh-confirm{padding:.5rem .625rem;max-width:20rem}
.ocsh-confirm p{margin:0 0 .5rem;line-height:1.4}
.ocsh-btn.p.dan{background:var(--red-fg);color:#fff}
/* phone (frames 9a-9b) */
.ocsh.ph .ocsh-grid,.ocsh-full .ph-grid{font-size:.875rem;height:22rem}
.ocsh.ph .ocsh-fx{height:2.75rem;font-size:.9375rem;background:var(--app)}
.ocsh.ph .ocsh-fxv{font-size:.9375rem}
.ocsh-acc{display:flex;gap:.25rem;padding:.375rem;background:var(--panel);border-bottom:1px solid var(--line);overflow-x:auto;flex:none}
.ocsh-acc button{flex:1 0 auto;min-width:2.75rem;height:2.75rem;border:0;border-radius:.5rem;background:var(--app);font-family:var(--mono);font-size:.8125rem;box-shadow:inset 0 0 0 1px var(--line)}
.ocsh-act{display:flex;align-items:center;gap:.25rem;padding:.25rem .375rem;border-top:1px solid var(--line);background:var(--panel);flex:none;overflow-x:auto}
.ocsh-act .ocsh-tbt{height:2.75rem;min-width:2.75rem;padding:0 .75rem;font-size:.8125rem;color:var(--fg)}
.ocsh-tbt:disabled{opacity:.4;cursor:default}
.ocsh-knob{position:absolute;width:.875rem;height:.875rem;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--app);z-index:6;touch-action:none}
.ocsh-knob::before{content:"";position:absolute;inset:-.9375rem}
.ocsh-knob.tl{left:-.4375rem;top:-.4375rem}.ocsh-knob.br{right:-.4375rem;bottom:-.4375rem}
.ocsh-mcap{font-size:.75rem;font-weight:600;color:var(--fg-3);padding:.375rem .625rem 0}
/* v0.4.1: merges past a frozen pane's edge, the pane's edge line */
.ocsh-pane.fzc::after{content:"";position:absolute;top:0;bottom:0;right:0;width:2px;background:var(--line-2);z-index:2;pointer-events:none}
.ocsh-pane.fzr::before{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--line-2);z-index:2;pointer-events:none}
/* comments on cells (6b) */
.ocsh-c.cm:not(.err)::before{content:"";position:absolute;top:0;right:0;border-top:.5rem solid var(--amber-fg);border-left:.5rem solid transparent;z-index:1}
.ocsh-th{width:19rem;max-width:100%;padding:.25rem}
.ocsh-th ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.625rem;max-height:18rem;overflow:auto}
.ocsh-cmt{display:flex;gap:.5rem;align-items:flex-start}
.ocsh-av{flex:none;width:1.75rem;height:1.75rem;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-size:.6875rem;font-weight:600}
.ocsh-cmb{flex:1;min-width:0}
.ocsh-cmh{display:flex;align-items:center;gap:.375rem;min-height:1.75rem}
.ocsh-cmh small{color:var(--fg-3);font-size:.75rem}
.ocsh-cmh .ocsh-ib{margin-left:auto;width:1.75rem;height:1.75rem}
.ocsh-cmb p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}
.ocsh-cm0{margin:.25rem .25rem .5rem;color:var(--fg-3)}
.ocsh-cmf{display:flex;gap:.375rem;margin-top:.625rem}
.ocsh-cmf input{flex:1;min-width:0;height:2rem;padding:0 .5rem;border-radius:.5rem;border:0;box-shadow:inset 0 0 0 1px var(--line-2);background:var(--app)}
.ocsh-cmf .ocsh-btn:disabled{opacity:.5;cursor:default}
/* charts floating over the sheet (4h) */
.ocsh-gw{position:relative;display:flex;flex-direction:column;flex:none;min-height:0}
.ocsh-full .ocsh-gw{flex:1}
.ocsh-chl{position:absolute;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:5}
.ocsh-chart{position:absolute;width:28rem;max-width:calc(100vw - 4rem);pointer-events:auto;border-radius:.875rem;background:var(--app);box-shadow:var(--sh-pop)}
.ocsh-chart.drag{opacity:.85;cursor:grabbing}
.ocsh-chart .occh{margin:0;box-shadow:none}
.ocsh-chbar{display:flex;align-items:center;gap:.25rem;padding:.25rem .375rem 0}
.ocsh-chbar .ocsh-ib:first-child{cursor:grab;touch-action:none}
.ocsh-chart .ocsh-load{height:9rem}
@media (max-width:45em){
  .ocsh-nb{width:4rem}
  .ocsh-tb{border-radius:.625rem}
  .ocsh-ib{width:2.25rem;height:2.25rem}
}
`;

let injected = false;
export function injectCss() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.setAttribute("data-oc", "sheet");
  el.textContent = CSS;
  document.head.appendChild(el);
}
