// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Styles for large tables and boards (prototype large-tables 1-4). Tokens only; no animation on
// scroll paths; the busy state tints instead of fading so text keeps its contrast.

export const LARGE_CSS = `
.ocdb-lt{position:relative}
.ocdb-lt-top{display:flex;align-items:center;gap:.5rem;min-height:0}
.ocdb-lt-busy{position:relative;display:inline-flex;align-items:center;height:1.5rem;padding:0 .5rem;margin:.25rem 0;border-radius:.375rem;background:var(--accent-soft);font-size:.75rem;color:var(--fg-2);overflow:hidden}
.ocdb-lt-busy i{position:absolute;left:0;bottom:0;height:3px;background:var(--accent)}
.ocdb-lt.busy .ocdb-lt-sc{background:var(--sunk)}
.ocdb-lt-sc{position:relative;height:min(70vh,40rem);overflow:auto;border-top:1px solid var(--line);contain:strict;overscroll-behavior:contain}
.ocdb-lt.phone .ocdb-lt-sc{height:min(75vh,44rem)}
.ocdb-lt-sp{position:relative}
.ocdb-lt-hd{position:sticky;top:0;z-index:3;background:var(--app);border-bottom:1px solid var(--line);font-size:.75rem;font-weight:550;color:var(--fg-3)}
.ocdb-lt-hd .ocdb-lt-h{position:absolute;top:0;height:100%;display:flex;align-items:center;padding:0 .625rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocdb-lt-fz{position:sticky;left:0;z-index:2;display:flex;height:100%;background:var(--app);box-shadow:1px 0 0 var(--line)}
.ocdb-lt-fz .ocdb-lt-h{position:static}
.ocdb-lt-r{position:absolute;top:0;left:0;min-width:100%;display:flex;border-bottom:1px solid var(--line);font-size:.8125rem;contain:layout style}
.ocdb-lt-r.sel,.ocdb-lt-r.sel .ocdb-lt-fz{background:var(--accent-soft)}
.ocdb-lt-r.flash,.ocdb-lt-r.flash .ocdb-lt-fz{background:var(--amber-bg)}
.ocdb-lt-num{width:4.5rem;flex:none;display:flex;align-items:center;justify-content:flex-end;padding:0 .625rem;border:0;background:none;color:var(--fg-3);font-size:.75rem;font-variant-numeric:tabular-nums}
.ocdb-lt-nb{all:unset;box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:flex-end;cursor:pointer;font:inherit;color:inherit}
.ocdb-lt-nb:focus-visible{outline:2px solid var(--accent-ring);outline-offset:-2px}
.ocdb-lt-r .ocdb-lt-num:hover{color:var(--fg)}
.ocdb-lt-ck{width:1rem;height:1rem;border-radius:.25rem;border:1px solid var(--line-2);background:var(--app)}
.ocdb-lt-ck[aria-checked=true],.ocdb-lt-ck[aria-checked=mixed]{background:var(--accent);border-color:var(--accent)}
.ocdb-lt-c{position:absolute;top:0;height:100%;display:flex;align-items:center;gap:.25rem;padding:0 .625rem;overflow:hidden;white-space:nowrap;min-width:0}
.ocdb-lt-c.fz{position:relative;font-weight:500}
.ocdb-lt-c.num{justify-content:flex-end;font-variant-numeric:tabular-nums}
.ocdb-lt-c:focus-visible{outline:2px solid var(--accent-ring);outline-offset:-2px}
.ocdb-lt-in{width:100%;height:1.875rem;border:0;border-radius:.375rem;box-shadow:inset 0 0 0 2px var(--accent);background:var(--app);padding:0 .375rem;font:inherit;outline:none}
.ocdb-lt-pos{position:absolute;right:1.25rem;z-index:4;padding:.25rem .5rem;border-radius:.375rem;background:var(--fg);color:var(--app);font-size:.75rem;font-variant-numeric:tabular-nums;pointer-events:none;white-space:nowrap}
.ocdb-lt-grab{position:absolute;right:.125rem;z-index:4;width:.75rem;height:2.75rem;border-radius:.375rem;background:var(--fg-3);touch-action:none}
.ocdb-lt-selbar{display:flex;align-items:center;gap:.375rem;padding:.375rem .25rem;flex-wrap:wrap}
.ocdb-lt.phone .ocdb-lt-selbar{position:sticky;bottom:0;z-index:5;background:var(--panel);box-shadow:var(--sh-pop);border-radius:.75rem;padding:.5rem;padding-bottom:calc(.5rem + env(safe-area-inset-bottom))}
.ocdb-lt.phone .ocdb-lt-selbar .ocdb-btn{min-height:2.75rem}
.ocdb-lt-cnt{font-size:.8125rem;font-weight:600;margin-right:.25rem}
.ocdb-btn.danger{color:var(--red-fg)}
.ocdb-lt-goto,.ocdb-lt-dlg{position:absolute;z-index:6;top:2.5rem;right:.5rem;background:var(--pop);box-shadow:var(--sh-pop);border-radius:.75rem;padding:.75rem;display:flex;flex-direction:column;gap:.5rem;width:min(20rem,calc(100vw - 2rem))}
.ocdb-lt-dlg{width:min(24rem,calc(100vw - 2rem))}
.ocdb-lt-goto label{display:flex;flex-direction:column;gap:.25rem;font-size:.8125rem;font-weight:600}
.ocdb-lt-run{position:sticky;bottom:.5rem;margin:.5rem auto 0;display:flex;align-items:center;gap:.5rem;width:max-content;max-width:100%;padding:.375rem .5rem .375rem .75rem;border-radius:.625rem;background:var(--fg);color:var(--app);font-size:.8125rem;overflow:hidden;position:relative}
.ocdb-lt-run i{position:absolute;left:0;bottom:0;height:3px;background:var(--accent)}
.ocdb-lt-run .ocdb-btn{color:inherit;background:none;box-shadow:none}
.ocdb-lt-cardc{display:flex;width:100%;height:100%}
.ocdb-lt-card{display:flex;flex-direction:column;justify-content:center;gap:.25rem;width:100%;height:100%;border:0;background:none;text-align:left;padding:0 .75rem;-webkit-user-select:none;user-select:none}
.ocdb-lt-card .t{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocdb-lt-card .t b{color:var(--fg-3);font-weight:500;font-variant-numeric:tabular-nums;margin-right:.25rem}
.ocdb-lt-card .m,.ocdb-lb-card .m{display:flex;gap:.5rem;align-items:center;font-size:.75rem;color:var(--fg-3);overflow:hidden;white-space:nowrap}
.ocdb-hcb{border:0;background:none;padding:.125rem .375rem;border-radius:.375rem;cursor:pointer}
.ocdb-hcb:hover{background:var(--hover);color:var(--fg)}
.ocdb-lb{display:flex;gap:.75rem;overflow-x:auto;padding:.5rem 0;align-items:flex-start}
.ocdb-lb-lane{flex:none;width:18rem;background:var(--sunk);border-radius:.75rem;display:flex;flex-direction:column}
.ocdb-lb-lane.closed{width:auto}
.ocdb-lb-hd{position:sticky;top:0;display:flex;align-items:center;gap:.375rem;padding:.5rem .5rem .375rem;font-size:.8125rem}
.ocdb-lb-tg{border:0;background:none;width:1.75rem;height:1.75rem;border-radius:.375rem;display:grid;place-items:center}
.ocdb-lb-n{margin-left:auto;font-size:.75rem;color:var(--fg-3);font-variant-numeric:tabular-nums}
.ocdb-lb-sc{height:min(65vh,38rem);overflow:auto;padding:0 .5rem .5rem;contain:strict;overscroll-behavior:contain;position:relative}
.ocdb-lb-card{position:absolute;left:0;right:0;top:0;display:flex;flex-direction:column;justify-content:center;gap:.25rem;border:0;text-align:left;background:var(--app);border-radius:.5rem;box-shadow:var(--sh-card);padding:0 .75rem;font-size:.8125rem}
.ocdb-lb-card .t{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocdb-lb-more{position:sticky;bottom:0;margin:0;padding:.375rem;text-align:center;font-size:.75rem;color:var(--fg-3);background:var(--sunk)}
`;
