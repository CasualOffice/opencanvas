// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// One stylesheet for the plugin's screens (MM-02). Every colour comes from Mattermost's theme
// variables (`--center-channel-bg-rgb`, `--button-bg-rgb`, …), so the card, panel and dialogs
// follow the user's theme, light or dark, like Mattermost's own UI.
// Sizes are rem (ADR-050) on Mattermost's root, which is 62.5 % (1rem = 10 px at the default
// size), the same scale Mattermost's own CSS uses; hairlines and shadows stay px; breakpoints em.

const css = `
.oc {
  --oc-fg: rgb(var(--center-channel-color-rgb));
  --oc-fg-2: rgba(var(--center-channel-color-rgb), .72);
  --oc-fg-3: rgba(var(--center-channel-color-rgb), .56);
  --oc-line: rgba(var(--center-channel-color-rgb), .16);
  --oc-line-2: rgba(var(--center-channel-color-rgb), .08);
  --oc-hover: rgba(var(--center-channel-color-rgb), .08);
  --oc-sunk: rgba(var(--center-channel-color-rgb), .04);
  --oc-bg: var(--center-channel-bg);
  --oc-acc: rgb(var(--button-bg-rgb));
  --oc-acc-fg: rgb(var(--button-color-rgb));
  --oc-acc-soft: rgba(var(--button-bg-rgb), .08);
  --oc-acc-soft-2: rgba(var(--button-bg-rgb), .16);
  --oc-link: rgb(var(--link-color-rgb));
  --oc-err: rgb(var(--error-text-color-rgb));
  --oc-warn: rgb(var(--away-indicator-rgb));
  --oc-ok: rgb(var(--online-indicator-rgb));
  color: var(--oc-fg);
  font-family: 'Open Sans', sans-serif;
}
.oc *, .oc *::before, .oc *::after { box-sizing: border-box; }
.oc button { font: inherit; }
.oc .lucide { flex: none; }
.oc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* buttons (Mattermost's primary, tertiary and icon buttons) */
.oc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.6rem; height: 3.2rem; padding: 0 1.6rem;
  border: 0; border-radius: 0.4rem; font-size: 1.2rem; font-weight: 600; line-height: 1.6rem; cursor: pointer; white-space: nowrap; }
.oc-btn.lg { height: 4rem; padding: 0 2rem; font-size: 1.4rem; }
.oc-btn.pri { background: var(--oc-acc); color: var(--oc-acc-fg); }
.oc-btn.pri:hover { background: linear-gradient(rgba(0,0,0,.08), rgba(0,0,0,.08)), var(--oc-acc); }
.oc-btn.pri:disabled { opacity: .64; cursor: default; }
.oc-btn.ter { background: transparent; color: var(--oc-acc); }
.oc-btn.ter:hover { background: var(--oc-acc-soft); }
.oc-btn:focus-visible, .oc-ib:focus-visible, .oc-row:focus-visible, .oc-opt:focus-within, .oc-card:focus-visible {
  outline: 2px solid rgba(var(--button-bg-rgb), .48); outline-offset: 1px; }
.oc-ib { display: inline-grid; place-items: center; width: 3.2rem; height: 3.2rem; border: 0; border-radius: 0.4rem;
  background: transparent; color: var(--oc-fg-3); cursor: pointer; }
.oc-ib:hover { background: var(--oc-hover); color: var(--oc-fg-2); }
.oc-ib[aria-expanded="true"] { background: var(--oc-acc-soft); color: var(--oc-acc); }
.oc-ib.sm { width: 2.8rem; height: 2.8rem; }

/* tiles */
.oc-tile { display: grid; place-items: center; width: 4rem; height: 4rem; border-radius: 0.8rem; flex: none;
  background: var(--oc-acc-soft); color: var(--oc-acc); }
.oc-tile.sm { width: 2.8rem; height: 2.8rem; border-radius: 0.6rem; }
.oc-tile.md { width: 3.6rem; height: 3.6rem; }
.oc-tile.mute { background: var(--oc-hover); color: var(--oc-fg-3); }

/* S1 card */
.oc-card { position: relative; display: flex; gap: 1.2rem; align-items: flex-start; max-width: 52rem; margin: 0.4rem 0 2px;
  padding: 1.4rem 1.4rem 1.4rem 1.6rem; border: 1px solid var(--oc-line); border-radius: 0.8rem; background: var(--oc-bg);
  box-shadow: 0 2px 3px rgba(0,0,0,.08); cursor: pointer; transition: box-shadow .15s, transform .15s, border-color .15s; text-align: left; }
.oc-card:hover { box-shadow: 0 6px 14px rgba(0,0,0,.12); transform: translateY(-1px); }
.oc-card.static { cursor: default; box-shadow: none; }
.oc-card.static:hover { transform: none; box-shadow: none; }
.oc-card.sel { border-color: var(--oc-acc); box-shadow: 0 0 0 1px var(--oc-acc); }
.oc-card .oc-body { flex: 1; min-width: 0; }
.oc-card .oc-titlerow { display: flex; align-items: flex-start; gap: 0.8rem; }
.oc-card .oc-titles { flex: 1; min-width: 0; padding-top: 1px; }
.oc-card .oc-title { font-size: 1.6rem; font-weight: 600; line-height: 2.2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-card.static .oc-title { color: var(--oc-fg-2); }
.oc-card .oc-meta { font-size: 1.2rem; line-height: 1.6rem; color: var(--oc-fg-3); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-card .oc-acts { display: flex; gap: 0.4rem; align-items: center; flex: none; }
.oc-skel { display: inline-block; height: 0.8rem; border-radius: 0.4rem; background: var(--oc-hover); vertical-align: middle;
  animation: oc-pulse 1.4s ease-in-out infinite; }
@keyframes oc-pulse { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) { .oc-skel, .oc-sk { animation: none; } .oc-card { transition: none; } }
@media (max-width: 56.1875em) { .oc-card .oc-expand { display: none; } }

/* menus */
.oc-menu { position: absolute; z-index: 1000; min-width: 23rem; padding: 0.8rem 0; border: 1px solid var(--oc-line); border-radius: 0.4rem;
  background: var(--oc-bg); box-shadow: 0 8px 24px rgba(0,0,0,.12); cursor: default; }
.oc-mi { display: flex; align-items: center; gap: 1rem; width: 100%; height: 3.6rem; padding: 0 1.6rem; border: 0; background: transparent;
  color: var(--oc-fg); font-size: 1.4rem; text-align: left; cursor: pointer; }
.oc-mi .lucide { color: var(--oc-fg-3); }
.oc-mi:hover, .oc-mi:focus-visible { background: var(--oc-hover); outline: none; }
.oc-mi:disabled { color: var(--oc-fg-3); opacity: .64; cursor: default; background: transparent; }
.oc-mi .oc-later { margin-left: auto; font-size: 1.2rem; color: var(--oc-fg-3); }
.oc-msep { height: 1px; margin: 0.8rem 0; background: var(--oc-line-2); }

/* S2 panel */
.oc-panel { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--oc-bg); }
.oc-ptitle { display: flex; align-items: center; gap: 1rem; min-width: 0; width: 100%; }
.oc-ptitle .oc-names { min-width: 0; flex: 1; line-height: 1.2; }
.oc-ptitle .oc-n1 { font-size: 1.6rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--oc-fg); }
.oc-ptitle .oc-n2 { font-size: 1.2rem; font-weight: 400; color: var(--oc-fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-ptitle .oc-hacts { display: flex; gap: 2px; margin-left: auto; }
.oc-frame { flex: 1; min-height: 0; width: 100%; border: 0; display: block; background: var(--oc-bg); }
.oc-frame.hide { visibility: hidden; position: absolute; inset: 0; }
.oc-skelpage { position: absolute; inset: 0; padding: 0; pointer-events: none; background: var(--oc-bg); }
.oc-sk { background: var(--oc-hover); border-radius: 0.6rem; animation: oc-pulse 1.4s ease-in-out infinite; }
.oc-skbar { display: flex; align-items: center; gap: 1rem; height: 4.9rem; padding: 0 1.2rem 0 0.8rem; border-bottom: 1px solid var(--oc-line-2); }
.oc-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  padding: 3.2rem 2.8rem 6.4rem; gap: 0.6rem; }
.oc-state .oc-tile { margin-bottom: 1rem; }
.oc-state h2 { margin: 0; font-size: 1.6rem; font-weight: 600; line-height: 2.4rem; color: var(--oc-fg); }
.oc-state p { margin: 0; max-width: 30rem; font-size: 1.4rem; line-height: 2rem; color: var(--oc-fg-2); }
.oc-state .oc-btn { margin-top: 1.4rem; }
.oc-foot { display: flex; align-items: center; gap: 0.8rem; padding: 1.2rem 1.4rem 1.2rem 1.6rem; border-top: 1px solid var(--oc-line);
  background: var(--oc-bg); font-size: 1.4rem; color: var(--oc-fg-2); }
.oc-foot .oc-btn { margin-left: auto; }
.oc-scrim { position: absolute; inset: 0; background: rgba(var(--center-channel-bg-rgb), .4); }

/* S7a copy fallback */
.oc-pop { position: absolute; z-index: 1001; right: 1.2rem; top: 0.8rem; width: 34rem; max-width: calc(100% - 2.4rem); padding: 1.4rem;
  border: 1px solid var(--oc-line); border-radius: 8px; background: var(--oc-bg); box-shadow: 0 12px 32px rgba(0,0,0,.18); }
.oc-pop.fixed { position: fixed; top: 7.2rem; right: 2.4rem; }
.oc-pop h3 { margin: 0 0 1rem; font-size: 1.4rem; font-weight: 600; }
.oc-pop input { width: 100%; height: 3.6rem; padding: 0 1rem; border: 2px solid var(--oc-acc); border-radius: 0.4rem;
  font: 1.3rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--oc-fg); background: var(--oc-bg); outline: none; }
.oc-pop .oc-warn { display: flex; gap: 0.8rem; margin-top: 1rem; font-size: 1.2rem; line-height: 1.8rem; color: var(--oc-warn); }
.oc-pop .oc-warn .lucide { margin-top: 1px; }
.oc-pop .oc-x { position: absolute; top: 0.8rem; right: 0.8rem; }

/* S4 list */
.oc-lhead { display: flex; align-items: center; justify-content: space-between; padding: 1.2rem 1.6rem; }
.oc-lhead span { font-size: 1.2rem; color: var(--oc-fg-3); }
.oc-rows { flex: 1; overflow: auto; border-top: 1px solid var(--oc-line-2); }
.oc-row { display: flex; align-items: center; gap: 1.2rem; width: 100%; min-height: 5.7rem; padding: 1rem 1.6rem; border: 0;
  border-bottom: 1px solid var(--oc-line-2); background: transparent; color: var(--oc-fg); text-align: left; cursor: pointer; }
.oc-row:hover { background: var(--oc-hover); }
.oc-row .oc-rt { min-width: 0; flex: 1; }
.oc-row .oc-r1 { font-size: 1.4rem; font-weight: 600; line-height: 2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-row .oc-r2 { font-size: 1.2rem; line-height: 1.6rem; color: var(--oc-fg-3); }
.oc-row.sk { cursor: default; }
.oc-row.sk:hover { background: transparent; }

/* S3 dialog */
.oc-overlay { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 1.6rem; background: rgba(0,0,0,.5); }
.oc-dialog { position: relative; width: 60rem; max-width: 100%; max-height: calc(100vh - 3.2rem); overflow: auto; padding: 2.8rem 3.2rem 3.2rem;
  border-radius: 12px; background: var(--oc-bg); color: var(--oc-fg); box-shadow: 0 20px 32px rgba(0,0,0,.12); }
.oc-dialog .oc-dhead { display: flex; align-items: baseline; gap: 1rem; margin: 0 4rem 2.2rem 0; }
.oc-dialog h1 { margin: 0; font-size: 2.2rem; font-weight: 600; line-height: 2.8rem; font-family: Metropolis, 'Open Sans', sans-serif; }
.oc-dialog .oc-dch { font-size: 1.4rem; color: var(--oc-fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oc-dialog .oc-x { position: absolute; top: 2.4rem; right: 2.4rem; }
.oc-field { position: relative; margin-bottom: 1.8rem; }
.oc-field input { width: 100%; height: 4rem; padding: 0 1.4rem; border: 1px solid var(--oc-line); border-radius: 0.4rem; outline: none;
  background: var(--oc-bg); color: var(--oc-fg); font-size: 14px; box-shadow: none; }
.oc-field input:hover { border-color: rgba(var(--center-channel-color-rgb), .48); }
.oc-field input:focus { border: 2px solid var(--oc-acc); padding: 0 1.3rem; }
.oc-field label { position: absolute; left: 1rem; top: -0.7rem; padding: 0 0.4rem; font-size: 1rem; line-height: 1.4rem; color: var(--oc-fg-3); background: var(--oc-bg); }
.oc-field input:focus + label { color: var(--oc-acc); }
.oc-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
@media (max-width: 35em) { .oc-opts { grid-template-columns: 1fr; } }
.oc-opt { position: relative; display: flex; gap: 1.2rem; padding: 1.4rem 4rem 1.4rem 1.4rem; border: 1px solid var(--oc-line); border-radius: 0.8rem; cursor: pointer; }
.oc-opt:hover { border-color: rgba(var(--center-channel-color-rgb), .32); }
.oc-opt.on { border: 2px solid var(--oc-acc); padding: 1.3rem 3.9rem 1.3rem 1.3rem; background: var(--oc-acc-soft); }
.oc-opt input { position: absolute; opacity: 0; pointer-events: none; }
.oc-opt .oc-o1 { font-size: 1.4rem; font-weight: 600; line-height: 2rem; }
.oc-opt .oc-o2 { font-size: 1.2rem; line-height: 1.6rem; color: var(--oc-fg-2); margin-top: 2px; }
.oc-radio { position: absolute; right: 1.4rem; top: 1.6rem; width: 1.6rem; height: 1.6rem; border: 1px solid rgba(var(--center-channel-color-rgb), .4); border-radius: 50%; }
.oc-opt.on .oc-radio { right: 1.3rem; top: 1.5rem; border: 0.5rem solid var(--oc-acc); background: var(--oc-bg); }
.oc-note { display: flex; gap: 1rem; align-items: center; margin-top: 1.8rem; font-size: 1.4rem; color: var(--oc-fg-3); }
.oc-note b { color: var(--oc-fg-2); font-weight: 600; }
.oc-err { display: flex; gap: 0.8rem; align-items: center; margin-top: 1.6rem; font-size: 1.4rem; color: var(--oc-err); }
.oc-dfoot { display: flex; justify-content: flex-end; gap: 0.8rem; margin-top: 2.8rem; }
`;

export function injectStyles() {
    if (document.getElementById('oc-mm-styles')) {
        return;
    }
    const el = document.createElement('style');
    el.id = 'oc-mm-styles';
    el.textContent = css;
    document.head.appendChild(el);
}
