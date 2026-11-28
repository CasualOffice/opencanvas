// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Styles for the board block. Injected once into document.head on first mount.
// Uses only design tokens from @opencanvas/ui/tokens.css; light and dark come free.

// Lucide icons take their size from a px attribute; this maps each size 1:1 to rem (identical at
// 16 px) so icons grow with the reader's text size (SCALE-02). Zero specificity: any rule that sizes
// an icon on purpose still wins.
const ICON_SIZES = [9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 32, 40];
export const ICON_REM = ICON_SIZES.map((n) => `:where(.ocbd,.ocdg) :where(svg.lucide[width="${n}"]){width:${n / 16}rem;height:${n / 16}rem}`).join("\n");

export const CSS = `
${ICON_REM}
.ocbd{font-family:var(--font);color:var(--fg);font-size:.875rem;line-height:1.5;-webkit-font-smoothing:antialiased;margin:.875rem 0;border-radius:var(--r-l);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;position:relative;background:var(--panel);outline:none;isolation:isolate}
.ocbd *{box-sizing:border-box}
:where(.ocbd) :where(button){font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ocbd :focus-visible{outline:2px solid var(--accent-ring);outline-offset:1px}
.ocbd svg.lucide{flex:none;display:block}
.ocbd:focus-visible{box-shadow:inset 0 0 0 1.5px var(--accent-ring)}
.ocbd-svg{display:block;width:100%;height:27.5rem;touch-action:none;user-select:none;-webkit-user-select:none}
.ocbd-dot{fill:var(--fg-4);opacity:.45}
.ocbd-svg text{font-family:var(--font)}
.ocbd-dock{position:absolute;left:.75rem;right:.75rem;bottom:.75rem;display:flex;align-items:flex-end;justify-content:space-between;gap:.5rem;z-index:2;pointer-events:none}
.ocbd-dock>*{pointer-events:auto}
.ocbd-tool{display:flex;gap:.125rem;padding:.25rem;border-radius:.75rem;background:var(--pop);box-shadow:var(--sh-pop);flex:none}
.ocbd-tool>*,.ocbd-tool .ocbd-ib{flex:none}
.ocbd-tool .ocbd-ib:focus-visible,.ocbd-zoom button:focus-visible{outline:.125rem solid var(--accent);outline-offset:.125rem}
.ocbd-ib{width:2rem;height:2rem;border:0;background:none;border-radius:.5rem;display:inline-grid;place-items:center;color:var(--fg-2);flex:none;padding:0;transition:background .2s var(--ease),color .2s var(--ease),transform .15s var(--ease)}
.ocbd-ib:hover{background:var(--hover);color:var(--fg)}
.ocbd-ib:active{transform:scale(.94);background:var(--press)}
.ocbd-ib:disabled{opacity:.35;pointer-events:none}
.ocbd-tool .ocbd-ib{width:2.125rem;height:2.125rem}
.ocbd-tool .ocbd-ib[aria-pressed="true"]{background:var(--fg);color:var(--app)}
.ocbd-vs{width:1px;margin:.375rem .1875rem;background:var(--line-2);flex:none;align-self:stretch}
.ocbd-zoom{margin-left:auto;flex:none;display:flex;align-items:center;padding:.1875rem;border-radius:.625rem;background:var(--pop);box-shadow:var(--sh-pop);font-size:.75rem;font-variant-numeric:tabular-nums;color:var(--fg-2);z-index:2}
.ocbd-zoom .ocbd-ib{width:1.75rem;height:1.75rem}
.ocbd-zl{min-width:2.75rem;height:1.75rem;text-align:center;border:0;background:none;border-radius:.4375rem;font-size:.75rem;color:var(--fg-2);padding:0 2px;font-variant-numeric:tabular-nums}
.ocbd-zl:hover{background:var(--hover);color:var(--fg)}
.ocbd-top{position:absolute;right:.75rem;top:.75rem;display:flex;gap:.25rem;z-index:2}
.ocbd-top .ocbd-ib{background:var(--pop);box-shadow:var(--sh-pop)}
.ocbd-swatch{position:absolute;display:flex;gap:.25rem;padding:.3125rem;border-radius:.625rem;background:var(--pop);box-shadow:var(--sh-pop);z-index:3;transform:translate(-50%,-100%);align-items:center;animation:ocbd-pop .2s var(--ease);white-space:nowrap}
.ocbd-swatch button[data-c]{width:1.375rem;height:1.375rem;border-radius:50%;border:0;box-shadow:inset 0 0 0 1px var(--line-2);padding:0;transition:transform .15s var(--ease)}
.ocbd-swatch button[data-c]:hover{transform:scale(1.1)}
.ocbd-swatch button[data-c][aria-pressed="true"]{box-shadow:inset 0 0 0 1px var(--line-2),0 0 0 2px var(--pop),0 0 0 3.5px var(--accent)}
.ocbd-swatch .ocbd-ib{width:1.75rem;height:1.75rem}
.ocbd-swatch .sep{width:1px;height:1.125rem;background:var(--line-2);margin:0 2px}
.ocbd-menu{position:absolute;right:.75rem;top:3.25rem;min-width:12.5rem;padding:.3125rem;border-radius:.75rem;background:var(--pop);box-shadow:var(--sh-pop);z-index:5;display:flex;flex-direction:column;animation:ocbd-menu .18s var(--ease)}
.ocbd-mi{display:flex;align-items:center;gap:.625rem;height:2.125rem;padding:0 .625rem;border:0;background:none;border-radius:.5rem;font-size:.8438rem;color:var(--fg);text-align:left;white-space:nowrap}
.ocbd-mi svg{color:var(--fg-2)}
.ocbd-mi:hover,.ocbd-mi:focus-visible{background:var(--hover)}
.ocbd-msep{height:1px;background:var(--line);margin:.25rem .375rem}
.ocbd-kbd{margin-left:auto;padding-left:1rem;font-family:var(--font);font-size:.75rem;color:var(--fg-2)}
.ocbd-dbtn{height:2rem;display:inline-flex;align-items:center;gap:.375rem;padding:0 .625rem 0 .5rem;border:0;border-radius:.5rem;background:var(--pop);box-shadow:var(--sh-pop);color:var(--fg-2);font-size:.8125rem;font-weight:500;white-space:nowrap;transition:background .2s var(--ease),color .2s var(--ease)}
.ocbd-dbtn:hover{background:var(--hover);color:var(--fg)}
.ocbd-scrim{position:absolute;inset:0;z-index:4}
.ocbd-ep{transition:r .15s var(--ease)}
.ocbd-cover{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding-bottom:1rem;z-index:4;background:linear-gradient(to top,color-mix(in srgb,var(--panel) 70%,transparent),transparent 50%);border:0;width:100%;cursor:pointer}
.ocbd-cover span{display:inline-flex;align-items:center;gap:.5rem;height:2.5rem;padding:0 1.125rem;border-radius:62.4375rem;background:var(--fg);color:var(--app);font-weight:500;font-size:.875rem;box-shadow:var(--sh-pop)}
.ocbd-edit{position:absolute;z-index:3;border:0;outline:none;resize:none;background:transparent;color:inherit;font-family:var(--font);padding:0;margin:0;overflow:hidden;line-height:1.43;box-shadow:0 0 0 1.5px var(--accent);border-radius:.25rem}
.ocbd-empty{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);color:var(--fg-3);font-size:.8438rem;display:flex;flex-direction:column;align-items:center;gap:.5rem;pointer-events:none;text-align:center;padding:0 1.5rem}
.ocbd-ph{border-radius:var(--r-l);background:var(--sunk);box-shadow:inset 0 0 0 1px var(--line);margin:.875rem 0;display:grid;place-items:center;color:var(--fg-3);font-size:.8125rem;font-family:var(--font)}

.ocbd.ocbd-full{position:fixed;inset:0;margin:0;border-radius:0;z-index:1000;display:flex;flex-direction:column;box-shadow:none}
.ocbd.ocbd-full .ocbd-svg{height:100%;flex:1}
.ocbd.ocbd-full .ocbd-dock{bottom:calc(.75rem + env(safe-area-inset-bottom,0px))}
.ocbd-moremenu{top:auto;right:auto;left:.75rem;bottom:3.75rem}
.ocbd-zoommenu{top:auto;right:.75rem;bottom:3.75rem}
.ocbd-ms{height:1px;margin:.25rem .375rem;background:var(--line-2)}
.ocbd-mi[aria-checked="true"]{font-weight:500}
.ocbd-mil{flex:1}
.ocbd-zoom[data-short] .ocbd-zl{min-width:2.75rem;height:2.75rem;font-size:.8125rem}
.ocbd[data-rail] .ocbd-dock{display:contents}
.ocbd[data-rail] .ocbd-tool{position:absolute;left:.75rem;top:50%;transform:translateY(-50%);flex-direction:column;z-index:2}
.ocbd[data-rail] .ocbd-vs{width:auto;height:1px;margin:.1875rem .375rem}
.ocbd[data-rail] .ocbd-zoom{position:absolute;right:.75rem;bottom:.75rem;z-index:2}
.ocbd.ocbd-full[data-rail] .ocbd-zoom{bottom:calc(.75rem + env(safe-area-inset-bottom,0px))}
.ocbd[data-rail] .ocbd-moremenu{left:3.75rem;top:.75rem;bottom:auto}

.ocbd-compact .ocbd-svg{height:18.75rem}
.ocbd-compact:not(.active):not(.ocbd-full) :is(.ocbd-dock,.ocbd-tool,.ocbd-zoom,.ocbd-top,.ocbd-swatch,.ocbd-menu){display:none}
.ocbd-compact .ocbd-tool .ocbd-ib{width:2.75rem;height:2.75rem}
.ocbd-compact .ocbd-ib{width:2.375rem;height:2.375rem}
.ocbd-compact .ocbd-mi{height:2.75rem;font-size:.9375rem}
.ocbd-compact .ocbd-menu{top:3.625rem}
.ocbd-compact :is(.ocbd-moremenu,.ocbd-zoommenu){top:auto;bottom:4.5rem}
.ocbd-compact[data-rail] .ocbd-moremenu{left:4.375rem;top:.75rem;bottom:auto}
.ocbd-compact .ocbd-zoom[data-short] .ocbd-zl{height:2.75rem}
.ocbd-compact .ocbd-zoom .ocbd-ib{width:2.375rem;height:2.375rem}
.ocbd-compact .ocbd-zl{height:2.375rem}
.ocbd-compact .ocbd-swatch button[data-c]{width:1.875rem;height:1.875rem}
.ocbd-compact .ocbd-swatch .ocbd-ib{width:2.375rem;height:2.375rem}
.ocbd-compact .ocbd-edit{font-size:1rem}

/* UX pass: screen-reader text, multi-select toolbar, fills, peers, guides */
.ocbd-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.ocbd-swatch{max-width:calc(100% - 1rem);overflow-x:auto;scrollbar-width:none}
.ocbd-swatch::-webkit-scrollbar{display:none}
.ocbd-swatch.below{transform:translate(-50%,0)}
.ocbd-swatch button[data-c].none{background:linear-gradient(135deg,transparent 46%,var(--red-fg) 46%,var(--red-fg) 54%,transparent 54%),var(--app)!important}
.ocbd-swatch .ocbd-ib[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}
.ocbd-top .ocbd-ib:disabled{opacity:.5}
.ocbd-empty-k{font-size:.75rem;color:var(--fg-4)}

/* Open items: minimap, connector waypoints */
.ocbd-zs{width:1px;height:1rem;background:var(--line-2);margin:0 .1875rem}
.ocbd-zoom .ocbd-ib[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}
.ocbd-mini{position:absolute;right:.75rem;bottom:3.5rem;z-index:2;border-radius:.75rem;background:var(--pop);box-shadow:var(--sh-pop);padding:0;overflow:hidden;animation:ocbd-menu .18s var(--ease);outline:none;line-height:0}
.ocbd-mini:focus-visible{box-shadow:var(--sh-pop),0 0 0 2px var(--accent-ring)}
.ocbd-mini svg{display:block;cursor:pointer;touch-action:none}
.ocbd-mini-vp{fill:var(--accent);fill-opacity:.08;stroke:var(--accent);stroke-width:1.5;cursor:grab}
.ocbd-mini-vp:active{cursor:grabbing}
.ocbd-wp,.ocbd-wpadd{transition:r .15s var(--ease),fill-opacity .15s var(--ease)}
.ocbd-wpadd{fill-opacity:.9}
.ocbd-wpadd:hover{fill:var(--accent-soft)}
.ocbd-compact .ocbd-mini{bottom:auto;top:3.625rem;right:.75rem}
.ocbd-compact .ocbd-zs{height:1.375rem}

@keyframes ocbd-menu{from{opacity:0;transform:translateY(-4px) scale(.98)}}
@keyframes ocbd-pop{from{opacity:0;transform:translate(-50%,calc(-100% + 4px)) scale(.98)}}
.ocbd-swatch[data-place="below"]{transform:translate(-50%,0);animation-name:ocbd-pop-below}
@keyframes ocbd-pop-below{from{opacity:0;transform:translate(-50%,-4px) scale(.98)}}
/* Whiteboard UX pass (BRD-18, BRD-19): context menu, sheet, tool lock, shortcuts, links */
.ocbd-ctx{right:auto;min-width:14.5rem;max-width:calc(100% - 1rem);max-height:calc(100% - 1rem);overflow:auto;z-index:8;animation:ocbd-menu .14s var(--ease)}
.ocbd-ctx .ocbd-mi{height:auto;min-height:2rem;width:100%;font-size:.8125rem}
.ocbd-ctx .ocbd-mi.open{background:var(--hover)}
.ocbd-mi[aria-disabled="true"]{color:var(--fg-4);cursor:default}
.ocbd-mi[aria-disabled="true"] svg{color:var(--fg-4)}
.ocbd-mi.danger,.ocbd-mi.danger svg{color:var(--red-fg)}
.ocbd-ck{width:1rem;display:inline-grid;place-items:center;flex:none}
.ocbd-chev{margin-left:auto;color:var(--fg-3)}
.ocbd-mh{font-size:.6875rem;color:var(--fg-2);font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:.4rem .625rem .25rem}
.ocbd-scrim{z-index:7}
.ocbd-scrim.dim{background:rgba(10,10,14,.32)}
.ocbd-ctx.sheet{left:0;right:0;top:auto;bottom:0;max-width:none;min-width:0;border-radius:1.25rem 1.25rem 0 0;padding:.5rem .75rem calc(1rem + env(safe-area-inset-bottom,0px));max-height:85%;animation:ocbd-sheet .2s var(--ease)}
.ocbd-ctx.sheet .ocbd-mi{min-height:2.75rem;font-size:.9375rem}
.ocbd-ctx.sheet .ocbd-kbd{display:none}
.ocbd-grab{width:2.25rem;height:.3rem;border-radius:62.4375rem;background:var(--line-2);margin:0 auto .5rem;flex:none}
.ocbd-sheet-h{font-weight:600;padding:.125rem .625rem .5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocbd-quick{display:grid;grid-template-columns:repeat(4,1fr);gap:.375rem;margin:0 0 .375rem}
.ocbd-quick button{border:0;background:var(--sunk);border-radius:.75rem;min-height:3.5rem;display:grid;place-items:center;gap:.125rem;font-size:.6875rem;color:var(--fg-2);padding:.375rem 0}
.ocbd-quick button.danger{color:var(--red-fg)}
.ocbd-quick button:focus-visible{outline:.125rem solid var(--accent);outline-offset:.125rem}
.ocbd-back b{font-weight:600}
.ocbd-tool .ocbd-ib{position:relative}
.ocbd-lk{position:absolute;right:.0625rem;bottom:.0625rem;width:.75rem;height:.75rem;border-radius:50%;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center}
.ocbd-lk svg.lucide{width:.5rem;height:.5rem}
.ocbd-tool .ocbd-lockbtn[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);box-shadow:inset 0 0 0 1.5px var(--accent)}
.ocbd-swatch .lbl{font-size:.75rem;color:var(--fg-2);padding:0 .375rem;font-weight:500}
.ocbd-linkbadge{cursor:pointer}
.ocbd-dlg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(30rem,calc(100% - 1.5rem));max-height:calc(100% - 1.5rem);overflow:auto;background:var(--pop);border-radius:1rem;box-shadow:var(--sh-pop);z-index:9;padding:1rem 1.125rem}
.ocbd-dlg-h{display:flex;align-items:center;gap:.5rem;margin:0 0 .5rem}
.ocbd-dlg-h h3{margin:0;font-size:1rem;font-weight:600;flex:1}
.ocbd-keys table{width:100%;border-collapse:collapse;font-size:.8125rem}
.ocbd-keys th{text-align:left;font-size:.6875rem;color:var(--fg-2);text-transform:uppercase;letter-spacing:.05em;padding:.6rem .25rem .25rem;font-weight:600}
.ocbd-keys td{padding:.3rem .25rem;border-bottom:1px solid var(--line)}
.ocbd-keys td:first-child{font-variant-numeric:tabular-nums;color:var(--fg-2);white-space:nowrap;width:45%}
.ocbd-new{font-size:.625rem;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:.03em}
.ocbd-linkpop{position:absolute;z-index:8;width:min(17.5rem,calc(100% - 1rem));background:var(--pop);border-radius:.75rem;box-shadow:var(--sh-pop);padding:.625rem;font-size:.8125rem}
.ocbd-linkpop label{display:flex;flex-direction:column;gap:.25rem;color:var(--fg-3);font-size:.75rem}
.ocbd-linkpop input{height:2rem;border:0;border-radius:.5rem;background:var(--sunk);padding:0 .5rem;color:var(--fg);font:inherit;font-size:.8125rem}
.ocbd-linkpop p{margin:.375rem 0 0;color:var(--red-fg);font-size:.75rem}
.ocbd-linkpop-a{display:flex;gap:.375rem;justify-content:flex-end;margin-top:.5rem}
.ocbd-btn{display:inline-flex;align-items:center;gap:.375rem;min-height:2rem;padding:0 .75rem;border-radius:.5rem;border:0;background:var(--sunk);color:var(--fg);font-size:.8125rem;font-weight:500}
.ocbd-btn.pri{background:var(--accent);color:var(--accent-fg)}
.ocbd-compact .ocbd-ctx .ocbd-mi,.ocbd-compact .ocbd-linkpop input{min-height:2.75rem}
/* BRD-22: style panel (style/StylePanel.tsx), fonts, rotation handle */
.ocbd-svg [data-font="serif"] text,.ocst-serif{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
.ocbd-svg [data-font="mono"] text,.ocst-mono{font-family:var(--mono,"Geist Mono",ui-monospace,Menlo,monospace)}
.ocst{position:absolute;right:.75rem;top:3.5rem;width:15.5rem;max-height:calc(100% - 8rem);overflow:auto;border-radius:.75rem;background:var(--pop);box-shadow:var(--sh-pop);z-index:4;padding:.5rem .75rem .75rem;animation:ocbd-menu .14s var(--ease);font-size:.8125rem;color:var(--fg)}
.ocst.sheet{left:0;right:0;top:auto;bottom:0;width:auto;border-radius:1.25rem 1.25rem 0 0;max-height:70%;padding:.5rem 1rem calc(1.25rem + env(safe-area-inset-bottom,0px));z-index:8;animation:ocbd-sheet .2s var(--ease)}
.ocst-embedded{position:static;width:auto;max-height:none;box-shadow:none;padding:0;background:none;animation:none}
.ocst-h{display:flex;align-items:center;gap:.375rem;font-weight:600;padding:.125rem 0 .25rem}
.ocst-h span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocst-h .ocbd-ib{width:1.75rem;height:1.75rem}
.ocst-sec{padding:.375rem 0 .25rem}
.ocst-l{font-size:.6875rem;color:var(--fg-2);font-weight:500;margin:0 0 .3rem;display:flex;justify-content:space-between}
.ocst-sw{display:flex;flex-wrap:wrap;gap:.25rem}
.ocst-sw button{width:1.375rem;height:1.375rem;border-radius:50%;border:0;padding:0;box-shadow:inset 0 0 0 1px var(--line-2)}
.ocst-sw button[aria-checked="true"]{box-shadow:inset 0 0 0 1px var(--line-2),0 0 0 2px var(--pop),0 0 0 3.5px var(--accent)}
.ocst-sw button.none{background:linear-gradient(135deg,transparent 46%,var(--red-fg) 46%,var(--red-fg) 54%,transparent 54%),var(--app)}
.ocst-seg{display:flex;padding:.15rem;border-radius:.5rem;background:var(--sunk);gap:.125rem}
.ocst-seg button{flex:1;border:0;background:none;min-height:1.75rem;border-radius:.375rem;font-size:.75rem;color:var(--fg-2);display:grid;place-items:center;padding:0 .25rem}
.ocst-seg button[aria-checked="true"]{background:var(--app);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.14)}
.ocst :focus-visible{outline:.125rem solid var(--accent);outline-offset:.125rem}
.ocst-g{width:1.5rem;height:.875rem;stroke:currentColor;fill:none}
.ocst-two{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.ocst-row{display:flex;align-items:center;gap:.5rem}
.ocst-row input[type=range]{flex:1;min-width:0;accent-color:var(--accent)}
.ocst-row output{font-size:.75rem;color:var(--fg-2);min-width:2.5rem;text-align:right;font-variant-numeric:tabular-nums}
.ocst-num{width:4.25rem;height:1.875rem;border-radius:.5rem;border:0;background:var(--sunk);padding:0 .5rem;font:inherit;font-size:.8125rem;color:var(--fg);font-variant-numeric:tabular-nums}
.ocst-sp{flex:1}
.ocst-hint{font-size:.6875rem;color:var(--fg-2);line-height:1.45;margin:.3rem 0 0}
.ocst.sheet .ocst-sw button{width:2.25rem;height:2.25rem}
.ocst.sheet .ocst-seg button{min-height:2.5rem}
.ocbd-compact .ocst .ocbd-ib{width:2.75rem;height:2.75rem}
@keyframes ocbd-sheet{from{transform:translateY(30%);opacity:0}}
@media (prefers-reduced-motion:reduce){.ocbd *{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

let injected = false;
export function ensureStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  if (document.querySelector("style[data-ocbd]")) return;
  const s = document.createElement("style");
  s.setAttribute("data-ocbd", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
