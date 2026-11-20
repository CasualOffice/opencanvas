// Styles for the board block. Injected once into document.head on first mount.
// Uses only design tokens from @opencanvas/ui/tokens.css; light and dark come free.

export const CSS = `
.ocbd{font-family:var(--font);color:var(--fg);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;margin:14px 0;border-radius:var(--r-l);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;position:relative;background:var(--panel);outline:none;isolation:isolate}
.ocbd *{box-sizing:border-box}
:where(.ocbd) :where(button){font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ocbd :focus-visible{outline:2px solid var(--accent-ring);outline-offset:1px}
.ocbd svg.lucide{flex:none;display:block}
.ocbd:focus-visible{box-shadow:inset 0 0 0 1.5px var(--accent-ring)}
.ocbd-svg{display:block;width:100%;height:440px;touch-action:none;user-select:none;-webkit-user-select:none}
.ocbd-dot{fill:var(--fg-4);opacity:.45}
.ocbd-svg text{font-family:var(--font)}
.ocbd-tool{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:2px;padding:4px;border-radius:12px;background:var(--pop);box-shadow:var(--sh-pop);z-index:2;max-width:calc(100% - 24px);overflow-x:auto;scrollbar-width:none}
.ocbd-tool::-webkit-scrollbar{display:none}
.ocbd-ib{width:32px;height:32px;border:0;background:none;border-radius:8px;display:inline-grid;place-items:center;color:var(--fg-2);flex:none;padding:0;transition:background .2s var(--ease),color .2s var(--ease),transform .15s var(--ease)}
.ocbd-ib:hover{background:var(--hover);color:var(--fg)}
.ocbd-ib:active{transform:scale(.94);background:var(--press)}
.ocbd-ib:disabled{opacity:.35;pointer-events:none}
.ocbd-tool .ocbd-ib{width:34px;height:34px}
.ocbd-tool .ocbd-ib[aria-pressed="true"]{background:var(--fg);color:var(--app)}
.ocbd-vs{width:1px;margin:6px 3px;background:var(--line-2);flex:none;align-self:stretch}
.ocbd-zoom{position:absolute;right:12px;bottom:12px;display:flex;align-items:center;padding:3px;border-radius:10px;background:var(--pop);box-shadow:var(--sh-pop);font-size:12px;font-variant-numeric:tabular-nums;color:var(--fg-2);z-index:2}
.ocbd-zoom .ocbd-ib{width:28px;height:28px}
.ocbd-zl{min-width:44px;height:28px;text-align:center;border:0;background:none;border-radius:7px;font-size:12px;color:var(--fg-2);padding:0 2px;font-variant-numeric:tabular-nums}
.ocbd-zl:hover{background:var(--hover);color:var(--fg)}
.ocbd-top{position:absolute;right:12px;top:12px;display:flex;gap:4px;z-index:2}
.ocbd-top .ocbd-ib{background:var(--pop);box-shadow:var(--sh-pop)}
.ocbd-swatch{position:absolute;display:flex;gap:4px;padding:5px;border-radius:10px;background:var(--pop);box-shadow:var(--sh-pop);z-index:3;transform:translate(-50%,-100%);align-items:center;animation:ocbd-pop .2s var(--ease);white-space:nowrap}
.ocbd-swatch button[data-c]{width:22px;height:22px;border-radius:50%;border:0;box-shadow:inset 0 0 0 1px var(--line-2);padding:0;transition:transform .15s var(--ease)}
.ocbd-swatch button[data-c]:hover{transform:scale(1.1)}
.ocbd-swatch button[data-c][aria-pressed="true"]{box-shadow:inset 0 0 0 1px var(--line-2),0 0 0 2px var(--pop),0 0 0 3.5px var(--accent)}
.ocbd-swatch .ocbd-ib{width:28px;height:28px}
.ocbd-swatch .sep{width:1px;height:18px;background:var(--line-2);margin:0 2px}
.ocbd-menu{position:absolute;right:12px;top:52px;min-width:200px;padding:5px;border-radius:12px;background:var(--pop);box-shadow:var(--sh-pop);z-index:5;display:flex;flex-direction:column;animation:ocbd-menu .18s var(--ease)}
.ocbd-mi{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border:0;background:none;border-radius:8px;font-size:13.5px;color:var(--fg);text-align:left;white-space:nowrap}
.ocbd-mi svg{color:var(--fg-2)}
.ocbd-mi:hover,.ocbd-mi:focus-visible{background:var(--hover)}
.ocbd-msep{height:1px;background:var(--line);margin:4px 6px}
.ocbd-scrim{position:absolute;inset:0;z-index:4}
.ocbd-ep{transition:r .15s var(--ease)}
.ocbd-cover{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding-bottom:16px;z-index:4;background:linear-gradient(to top,color-mix(in srgb,var(--panel) 70%,transparent),transparent 50%);border:0;width:100%;cursor:pointer}
.ocbd-cover span{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 18px;border-radius:999px;background:var(--fg);color:var(--app);font-weight:500;font-size:14px;box-shadow:var(--sh-pop)}
.ocbd-edit{position:absolute;z-index:3;border:0;outline:none;resize:none;background:transparent;color:inherit;font-family:var(--font);padding:0;margin:0;overflow:hidden;line-height:1.43;box-shadow:0 0 0 1.5px var(--accent);border-radius:4px}
.ocbd-empty{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);color:var(--fg-3);font-size:13.5px;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;text-align:center;padding:0 24px}
.ocbd-ph{border-radius:var(--r-l);background:var(--sunk);box-shadow:inset 0 0 0 1px var(--line);margin:14px 0;display:grid;place-items:center;color:var(--fg-3);font-size:13px;font-family:var(--font)}

.ocbd.ocbd-full{position:fixed;inset:0;margin:0;border-radius:0;z-index:1000;display:flex;flex-direction:column;box-shadow:none}
.ocbd.ocbd-full .ocbd-svg{height:100%;flex:1}
.ocbd.ocbd-full .ocbd-tool{bottom:calc(12px + env(safe-area-inset-bottom,0px))}

.ocbd-compact .ocbd-svg{height:300px}
.ocbd-compact:not(.active):not(.ocbd-full) :is(.ocbd-tool,.ocbd-zoom,.ocbd-top,.ocbd-swatch,.ocbd-menu){display:none}
.ocbd-compact .ocbd-tool .ocbd-ib{width:40px;height:40px}
.ocbd-compact .ocbd-ib{width:38px;height:38px}
.ocbd-compact .ocbd-zoom{bottom:auto;top:12px;right:100px}
.ocbd-compact .ocbd-mi{height:44px;font-size:15px}
.ocbd-compact .ocbd-menu{top:58px}
.ocbd-compact .ocbd-zoom .ocbd-ib{width:38px;height:38px}
.ocbd-compact .ocbd-zl{height:38px}
.ocbd-compact .ocbd-swatch button[data-c]{width:30px;height:30px}
.ocbd-compact .ocbd-swatch .ocbd-ib{width:38px;height:38px}
.ocbd-compact .ocbd-edit{font-size:16px}

@keyframes ocbd-menu{from{opacity:0;transform:translateY(-4px) scale(.98)}}
@keyframes ocbd-pop{from{opacity:0;transform:translate(-50%,calc(-100% + 4px)) scale(.98)}}
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
