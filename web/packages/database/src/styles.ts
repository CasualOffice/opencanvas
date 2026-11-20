// Styles for the database block. Injected once into document.head on first mount.
// Uses only design tokens from @opencanvas/ui/tokens.css; light and dark come free.

export const CSS = `
.ocdb,.ocdb-layer{font-family:var(--font);color:var(--fg);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.ocdb *,.ocdb-layer *{box-sizing:border-box}
:where(.ocdb,.ocdb-layer) :where(button,input,textarea){font:inherit;color:inherit;letter-spacing:inherit}
:where(.ocdb,.ocdb-layer) :where(button){cursor:pointer;-webkit-tap-highlight-color:transparent}
.ocdb button:disabled,.ocdb-layer button:disabled{cursor:default}
.ocdb :focus-visible,.ocdb-layer :focus-visible{outline:2px solid var(--accent-ring);outline-offset:1px;border-radius:6px}
.ocdb svg.lucide,.ocdb-layer svg.lucide{flex:none;display:block}

.ocdb{margin:14px 0 18px;position:relative}
.ocdb-h{display:flex;align-items:center;gap:8px;margin-bottom:6px;min-width:0}
.ocdb-hi{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;flex:none}
.ocdb-hn{font-size:17px;font-weight:620;letter-spacing:-.012em;border:0;background:none;outline:none;min-width:0;flex:0 1 auto;padding:2px 4px;margin-left:-4px;border-radius:6px;field-sizing:content;max-width:100%}
.ocdb-hn:hover:not(:read-only){background:var(--hover)}
.ocdb-hn:focus{background:var(--hover)}
.ocdb-hc{font-size:12px;color:var(--fg-3);font-variant-numeric:tabular-nums;white-space:nowrap}

.ocdb-bar{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--line);min-height:40px}
.ocdb-tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0;align-self:stretch}
.ocdb-tabs::-webkit-scrollbar{display:none}
.ocdb-tab{border:0;background:none;display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 10px;font-size:13px;color:var(--fg-3);position:relative;white-space:nowrap;transition:color .2s var(--ease)}
.ocdb-tab:hover{color:var(--fg)}
.ocdb-tab[aria-selected="true"]{color:var(--fg);font-weight:500}
.ocdb-tab[aria-selected="true"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--fg)}
.ocdb-tools{display:flex;align-items:center;gap:1px;flex:none}
.ocdb-ib{width:30px;height:30px;border:0;background:none;border-radius:8px;display:inline-grid;place-items:center;color:var(--fg-2);flex:none;padding:0;transition:background .2s var(--ease),color .2s var(--ease),transform .15s var(--ease)}
.ocdb-ib:hover{background:var(--hover);color:var(--fg)}
.ocdb-ib:active{transform:scale(.94);background:var(--press)}
.ocdb-ib.on{color:var(--accent)}
.ocdb-search{width:0;opacity:0;border:0;background:none;outline:none;font-size:13px;transition:width .35s var(--ease),opacity .25s;padding:0;min-width:0}
.ocdb-search.show{width:150px;opacity:1;padding:0 6px}
.ocdb-chips{display:flex;gap:6px;flex-wrap:wrap;padding:8px 0 0}
.ocdb-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 4px 0 10px;border-radius:999px;font-size:12px;background:var(--accent-soft);color:var(--accent);border:0;max-width:100%;white-space:nowrap}
.ocdb-chip>span{overflow:hidden;text-overflow:ellipsis}
.ocdb-chip-x{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;border:0;background:none;color:inherit;padding:0;flex:none}
.ocdb-chip-x:hover{background:var(--accent-ring)}
.ocdb-view{position:relative}

/* table */
.ocdb-gw{overflow-x:auto;overscroll-behavior-x:contain}
.ocdb-grid{border-collapse:separate;border-spacing:0;font-size:14px;min-width:100%;table-layout:fixed}
.ocdb-grid th{height:36px;padding:0;text-align:left;font-weight:500;color:var(--fg-3);font-size:12.5px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);white-space:nowrap;background:var(--app)}
.ocdb-grid th:last-child,.ocdb-grid td:last-child{border-right:0}
.ocdb-hcell{width:100%;height:36px;display:flex;align-items:center;gap:6px;padding:0 10px;border:0;background:none;color:inherit;font-weight:500;font-size:12.5px;text-align:left;overflow:hidden}
.ocdb-hcell span{overflow:hidden;text-overflow:ellipsis}
.ocdb-hcell:hover{background:var(--hover);color:var(--fg)}
.ocdb-sortic{margin-left:auto;color:var(--accent)}
.ocdb-grid td{height:40px;padding:0;border-bottom:1px solid var(--line);border-right:1px solid var(--line);vertical-align:middle;position:relative;background:var(--app)}
.ocdb-grid tbody tr:hover td{background:var(--panel)}
.ocdb-cin{padding:0 10px;height:40px;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;width:100%;border:0;background:none;text-align:left;color:inherit;font-size:14px}
button.ocdb-cin{cursor:pointer}
button.ocdb-cin:hover{background:var(--hover)}
button.ocdb-cin:disabled{cursor:default;background:none}
.ocdb-ct{display:flex;align-items:center;gap:6px;padding:0 6px 0 10px;height:40px}
.ocdb-ce{flex:1;min-width:0;border:0;background:none;outline:none;padding:0;height:100%;font-size:14px;color:var(--fg);text-overflow:ellipsis}
.ocdb-ce::placeholder{color:var(--fg-4)}
.ocdb-ct .ocdb-ce{font-weight:500}
.ocdb-ct .ocdb-ce::placeholder{font-weight:400}
.ocdb-num{justify-content:flex-end;font-variant-numeric:tabular-nums}
.ocdb-num .ocdb-ce{text-align:right;font-variant-numeric:tabular-nums}
.ocdb-peekbtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;border-radius:6px;border:0;background:var(--app);box-shadow:inset 0 0 0 1px var(--line-2),var(--sh-1);font-size:11.5px;color:var(--fg-2);opacity:0;transition:opacity .2s var(--ease);flex:none}
.ocdb-grid tr:hover .ocdb-peekbtn,.ocdb-peekbtn:focus-visible{opacity:1}
.ocdb-addcol button{width:100%;height:36px;border:0;background:none;color:var(--fg-3);display:grid;place-items:center}
.ocdb-addcol button:hover{background:var(--hover);color:var(--fg)}
.ocdb-grid tfoot td{height:34px;border-bottom:0;font-size:12px;color:var(--fg-3);background:var(--app)}
.ocdb-grid tfoot tr:hover td{background:var(--app)}
.ocdb-grid tfoot .ocdb-cin{height:34px;font-variant-numeric:tabular-nums;font-size:12px}
.ocdb-grid tfoot b{font-weight:500;color:var(--fg-2);margin-left:4px}
.ocdb-newrow{display:flex;align-items:center;gap:8px;height:38px;padding:0 10px;color:var(--fg-3);font-size:13.5px;border:0;background:none;width:100%;border-bottom:1px solid var(--line);text-align:left;position:sticky;left:0}
.ocdb-newrow:hover{background:var(--hover);color:var(--fg)}
.ocdb-nomatch{padding:22px 10px;color:var(--fg-3);font-size:13.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}

.ocdb-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;font-size:12.5px;font-weight:500;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;flex:none}
.ocdb-pill.st::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85;flex:none}
.ocdb-c-gray{background:var(--gray-bg);color:var(--gray-fg)} .ocdb-c-blue{background:var(--blue-bg);color:var(--blue-fg)} .ocdb-c-amber{background:var(--amber-bg);color:var(--amber-fg)} .ocdb-c-green{background:var(--green-bg);color:var(--green-fg)}
.ocdb-c-red{background:var(--red-bg);color:var(--red-fg)} .ocdb-c-purple{background:var(--purple-bg);color:var(--purple-fg)} .ocdb-c-pink{background:var(--pink-bg);color:var(--pink-fg)}
.ocdb-person{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;white-space:nowrap;min-width:0}
.ocdb-person>span:last-child{overflow:hidden;text-overflow:ellipsis}
.ocdb-av{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:8.5px;font-weight:600;letter-spacing:.02em;flex:none;overflow:hidden}
.ocdb-av img{width:100%;height:100%;object-fit:cover}
.ocdb-av.xs{width:16px;height:16px;font-size:7.5px}
.ocdb-av.md{width:24px;height:24px;font-size:9.5px}
.ocdb-emptyc{color:var(--fg-4);font-size:13px}
.ocdb-prog{display:flex;align-items:center;gap:8px;width:100%}
.ocdb-prog i{flex:1;height:5px;border-radius:3px;background:var(--hover);overflow:hidden;position:relative;display:block}
.ocdb-prog i b{position:absolute;inset:0 auto 0 0;background:var(--accent);border-radius:3px;transition:width .3s var(--ease)}
.ocdb-prog span{font-variant-numeric:tabular-nums;font-size:12.5px;color:var(--fg-2);width:36px;text-align:right}
.ocdb-url{color:var(--fg-2);text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocdb-url:hover{color:var(--accent)}
.ocdb-cbx{width:18px;height:18px;flex:none;border-radius:5px;border:0;box-shadow:inset 0 0 0 1.5px var(--line-2);background:var(--app);display:grid;place-items:center;color:transparent;padding:0;transition:background .2s var(--ease),box-shadow .2s var(--ease)}
.ocdb-cbx:hover:not(:disabled){box-shadow:inset 0 0 0 1.5px var(--fg-3)}
.ocdb-cbx.on{background:var(--accent);box-shadow:none;color:var(--accent-fg)}

/* kanban */
.ocdb-kan{display:flex;gap:12px;overflow-x:auto;padding:12px 2px 6px;scroll-snap-type:x mandatory;overscroll-behavior-x:contain}
.ocdb-kcol{flex:0 0 264px;scroll-snap-align:start;display:flex;flex-direction:column;gap:8px;border-radius:12px;padding:8px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);transition:background .2s}
.ocdb-kcol.over{background:var(--accent-soft)}
.ocdb-khead{display:flex;align-items:center;gap:8px;padding:2px 2px 4px;font-size:12.5px;color:var(--fg-3);min-height:30px}
.ocdb-khead .kc{font-variant-numeric:tabular-nums}
.ocdb-khead .ocdb-ib{width:26px;height:26px;margin-left:auto}
.ocdb-kcard{background:var(--app);border-radius:10px;padding:10px 12px;box-shadow:inset 0 0 0 1px var(--line),var(--sh-1);display:flex;flex-direction:column;gap:8px;cursor:pointer;transition:box-shadow .25s var(--ease),transform .25s var(--ease),opacity .2s;text-align:left;border:0;width:100%;color:inherit}
.ocdb-kcard.movable{cursor:grab;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.ocdb-kcard.picked{box-shadow:0 0 0 2px var(--accent),var(--sh-card);transform:translateY(-1px)}
.ocdb-kan.dragging{scroll-snap-type:none}
.ocdb-kan.dragging .ocdb-kcard{cursor:grabbing}
.ocdb-kan.dragging .ocdb-kcard:hover{transform:none}
.ocdb-kdrop{height:3px;border-radius:2px;background:var(--accent);margin:-4px 4px;flex:none;animation:ocdb-kdrop .15s var(--ease)}
@keyframes ocdb-kdrop{from{opacity:0;transform:scaleX(.6)}}
.ocdb-kghost{position:fixed;z-index:2000;pointer-events:none;font-family:var(--font);color:var(--fg);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;background:var(--app);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 0 0 1px var(--line-2),var(--sh-pop);transform:rotate(1.5deg) scale(1.02);opacity:.96}
.ocdb-kghost svg.lucide{flex:none;display:block}
.ocdb-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.ocdb-kcard:hover{box-shadow:inset 0 0 0 1px var(--line-2),var(--sh-card);transform:translateY(-1px)}
.ocdb-kcard.dragging{opacity:.4}
.ocdb-kt{font-size:14px;font-weight:500;line-height:1.4;overflow-wrap:anywhere}
.ocdb-kt.untitled{color:var(--fg-4);font-weight:400}
.ocdb-km{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--fg-3)}
.ocdb-km>span{display:inline-flex;gap:5px;align-items:center}
.ocdb-km:empty{display:none}
.ocdb-kadd{border:0;background:none;display:flex;align-items:center;gap:6px;height:32px;padding:0 6px;border-radius:8px;color:var(--fg-3);font-size:13px}
.ocdb-kadd:hover{background:var(--hover);color:var(--fg)}
.ocdb-hint{color:var(--fg-3);padding:16px 0;font-size:13.5px;margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* calendar */
.ocdb-cal{padding-top:10px}
.ocdb-calh{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.ocdb-calh b{font-size:14px;font-weight:600;margin-right:auto}
.ocdb-calg{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-radius:12px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--line);background:var(--line);gap:1px}
.ocdb-dow{background:var(--panel);font-size:11.5px;color:var(--fg-3);padding:6px 8px;text-transform:uppercase;letter-spacing:.06em}
.ocdb-day{background:var(--app);min-height:92px;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:0;position:relative}
.ocdb-day.out{background:var(--panel)} .ocdb-day.out .ocdb-dn{color:var(--fg-4)}
.ocdb-dn{font-size:12px;color:var(--fg-3);font-variant-numeric:tabular-nums;width:22px;height:22px;display:grid;place-items:center;border-radius:50%}
.ocdb-day.today .ocdb-dn{background:var(--accent);color:var(--accent-fg);font-weight:600}
.ocdb-dadd{position:absolute;top:5px;right:5px;width:22px;height:22px;border-radius:6px;border:0;background:none;color:var(--fg-3);display:grid;place-items:center;opacity:0;transition:opacity .2s var(--ease)}
.ocdb-day:hover .ocdb-dadd,.ocdb-dadd:focus-visible{opacity:1}
.ocdb-dadd:hover{background:var(--hover);color:var(--fg)}
.ocdb-cev{border:0;text-align:left;font-size:12px;padding:3px 6px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;width:100%;display:block;height:auto;transition:filter .2s}
.ocdb-cev:hover{filter:brightness(.97)}
.ocdb-agenda{display:flex;flex-direction:column;gap:14px;padding-top:6px}
.ocdb-ad{font-size:12px;color:var(--fg-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
.ocdb-ai{display:flex;gap:10px;align-items:center;padding:10px 12px;min-height:44px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);margin-bottom:6px;background:var(--app);border:0;width:100%;text-align:left;font-size:14px}
.ocdb-ai .dot{width:8px;height:8px;border-radius:50%;flex:none;background:currentColor}
.ocdb-ai .t{flex:1;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* gallery */
.ocdb-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding-top:12px}
.ocdb-gcard{border-radius:14px;padding:5px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);border:0;text-align:left;color:inherit;transition:transform .35s var(--ease),box-shadow .35s var(--ease);min-width:0;display:flex;flex-direction:column}
.ocdb-gcard:hover{transform:translateY(-2px);box-shadow:inset 0 0 0 1px var(--line-2),var(--sh-card)}
.ocdb-gcov{height:92px;border-radius:10px;display:grid;place-items:center}
.ocdb-gcov svg{opacity:.8}
.ocdb-gb{padding:10px 8px 6px;display:flex;flex-direction:column;gap:6px;min-width:0}
.ocdb-gt{font-weight:550;font-size:14px;overflow-wrap:anywhere}
.ocdb-gt.untitled{color:var(--fg-4);font-weight:400}
.ocdb-gnew{display:grid;place-items:center;min-height:150px;color:var(--fg-3)}
.ocdb-gnew>span{display:flex;gap:6px;align-items:center}

/* layer: popovers, sheets, modals, side peek */
.ocdb-scrim{position:fixed;inset:0;z-index:1002;background:rgba(10,10,14,.32);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:ocdb-fade .25s var(--ease)}
.ocdb-scrim.clear{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none}
.ocdb-pop{position:fixed;z-index:1003;min-width:220px;max-width:min(320px,calc(100vw - 16px));max-height:min(420px,calc(100vh - 24px));overflow:auto;background:var(--pop);border-radius:12px;box-shadow:var(--sh-pop);padding:5px;animation:ocdb-pop .22s var(--ease);overscroll-behavior:contain}
.ocdb-sheet{position:fixed;left:0;right:0;bottom:0;z-index:1003;background:var(--pop);border-radius:20px 20px 0 0;box-shadow:0 -12px 40px -12px rgba(0,0,0,.35);max-height:78vh;overflow:auto;padding:6px 10px calc(14px + env(safe-area-inset-bottom,0px));animation:ocdb-up .42s var(--ease);overscroll-behavior:contain}
.ocdb-grab{width:38px;height:4px;border-radius:2px;background:var(--line-2);margin:6px auto 8px}
.ocdb-sht{font-size:15px;font-weight:600;padding:2px 8px 8px}
.ocdb-mh{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--fg-3);padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.ocdb-mi{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:4px 10px;border:0;background:none;border-radius:8px;text-align:left;font-size:13.5px;color:var(--fg)}
.ocdb-mi:hover,.ocdb-mi.on{background:var(--hover)}
.ocdb-mi>svg{color:var(--fg-2)}
.ocdb-mi .mk{margin-left:auto;font-size:11.5px;color:var(--fg-3);font-family:var(--mono);white-space:nowrap}
.ocdb-mi .chk{margin-left:auto;color:var(--accent);display:grid}
.ocdb-mi .lbl{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocdb-mi.danger,.ocdb-mi.danger>svg{color:var(--red-fg)}
.ocdb-msep{height:1px;background:var(--line);margin:5px 4px}
.ocdb-pad{padding:6px}
.ocdb-pin{width:100%;height:34px;border:0;border-radius:8px;box-shadow:inset 0 0 0 1px var(--line-2);background:var(--app);padding:0 10px;font-size:13.5px;outline:none;color:var(--fg)}
.ocdb-pin:focus{box-shadow:inset 0 0 0 1.5px var(--accent)}
.ocdb-pin:disabled{opacity:.7}
.ocdb-note{font-size:12px;color:var(--fg-3);padding:0 10px 6px}
.ocdb-range{display:flex;gap:10px;align-items:center;min-width:240px;padding:10px}
.ocdb-range input{flex:1;accent-color:var(--accent)}
.ocdb-range b{font-variant-numeric:tabular-nums;width:44px;text-align:right;font-weight:550}
.ocdb-sheet .ocdb-mi{min-height:46px;font-size:15px;padding:6px 10px}
.ocdb-compact .ocdb-pin,.ocdb-compact textarea,.ocdb-compact input{font-size:16px}
.ocdb-compact .ocdb-pin{height:42px}

.ocdb-btn{height:32px;border:0;border-radius:8px;padding:0 12px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:13px;font-weight:500;background:var(--app);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2),var(--sh-1);transition:background .2s var(--ease),transform .15s var(--ease),opacity .2s;white-space:nowrap}
.ocdb-btn:hover{background:var(--panel)}
.ocdb-btn:active{transform:scale(.98)}
.ocdb-btn.primary{background:var(--fg);color:var(--app);box-shadow:none}
.ocdb-btn.primary:hover{filter:brightness(1.15)}
.ocdb-btn.primary:disabled{opacity:.4;filter:none;transform:none}
.ocdb-btn.ghost{box-shadow:none;background:none;color:var(--fg-2)} .ocdb-btn.ghost:hover{background:var(--hover);color:var(--fg)}
.ocdb-btn.sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:7px}
.ocdb-compact .ocdb-btn{height:42px;padding:0 16px;font-size:14px}

.ocdb-modal{position:fixed;z-index:1003;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 32px);overflow:auto;background:var(--pop);border-radius:18px;box-shadow:var(--sh-pop);animation:ocdb-modal .4s var(--ease)}
.ocdb-modal.ocdb-compact{top:auto;bottom:0;left:0;right:0;transform:none;width:auto;border-radius:20px 20px 0 0;max-height:88vh;animation:ocdb-up .45s var(--ease);padding-bottom:env(safe-area-inset-bottom,0px)}
.ocdb-mhd{display:flex;align-items:flex-start;gap:12px;padding:20px 20px 0}
.ocdb-mhd h2{font-size:18px;font-weight:650;letter-spacing:-.015em;margin:0}
.ocdb-mhd p{margin:4px 0 0;color:var(--fg-3);font-size:13.5px}
.ocdb-mhd .ocdb-ib{margin-left:auto;width:32px;height:32px}
.ocdb-mbd{padding:16px 20px}
.ocdb-mft{display:flex;justify-content:flex-end;gap:8px;padding:0 20px 20px;flex-wrap:wrap}
.ocdb-drop{border-radius:12px;border:1.5px dashed var(--line-2);padding:18px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;color:var(--fg-3);font-size:13px;transition:background .2s,border-color .2s}
.ocdb-drop.over{background:var(--accent-soft);border-color:var(--accent)}
.ocdb-drop b{color:var(--fg);font-weight:550}
.ocdb-drop label{color:var(--accent);cursor:pointer;font-weight:500}
.ocdb-or{display:flex;align-items:center;gap:8px;margin:14px 0 6px;font-size:12.5px;color:var(--fg-3)}
.ocdb-or .ocdb-btn{margin-left:auto}
textarea.ocdb-pin{height:120px;padding:10px;resize:vertical;font-family:var(--mono);font-size:12.5px;line-height:1.55;display:block}
.ocdb-compact textarea.ocdb-pin{font-size:16px}
.ocdb-prev{margin-top:12px;overflow:auto;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);max-height:200px}
.ocdb-prev table{border-collapse:collapse;font-size:12.5px;width:100%}
.ocdb-prev th,.ocdb-prev td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.ocdb-prev th{color:var(--fg-3);font-weight:500;background:var(--panel);position:sticky;top:0}
.ocdb-prev th small{display:flex;align-items:center;gap:4px;font-weight:400;color:var(--accent);font-size:11px}
.ocdb-prevn{font-size:12px;color:var(--fg-3);margin-top:6px}
.ocdb-err{font-size:12.5px;color:var(--red-fg);margin-top:8px;display:flex;gap:6px;align-items:center}

.ocdb-side{position:fixed;top:0;right:0;bottom:0;width:380px;max-width:100vw;z-index:1001;border-left:1px solid var(--line);background:var(--app);display:flex;flex-direction:column;min-height:0;box-shadow:-24px 0 60px -40px rgba(0,0,0,.35);animation:ocdb-in .4s var(--ease)}
.ocdb-side.ocdb-compact{inset:0;width:auto;border-left:0;animation:ocdb-up .45s var(--ease)}
.ocdb-shd{height:48px;display:flex;align-items:center;gap:6px;padding:0 8px 0 16px;border-bottom:1px solid var(--line);flex:none;font-size:13px;color:var(--fg-3);white-space:nowrap}
.ocdb-shd>span{overflow:hidden;text-overflow:ellipsis}
.ocdb-shd .grow{flex:1}
.ocdb-shd .ocdb-ib{width:32px;height:32px}
.ocdb-compact .ocdb-shd{height:54px}
.ocdb-compact .ocdb-shd .ocdb-ib{width:40px;height:40px}
.ocdb-sbd{flex:1;overflow:auto;padding:18px 18px 40px;overscroll-behavior:contain}
.ocdb-side .ocdb-ptitle{font-size:24px;font-weight:680;letter-spacing:-.022em;line-height:1.2;outline:none;margin:0 0 16px;border:0;background:none;width:100%;padding:0;color:var(--fg);resize:none;field-sizing:content;font-family:inherit;overflow:hidden}
.ocdb-side .ocdb-ptitle::placeholder{color:var(--fg-4)}
.ocdb-props{display:grid;grid-template-columns:120px minmax(0,1fr);gap:2px 8px;align-items:center;font-size:13.5px}
.ocdb-pk{display:flex;align-items:center;gap:8px;color:var(--fg-3);height:36px;min-width:0;white-space:nowrap;overflow:hidden}
.ocdb-pk span{overflow:hidden;text-overflow:ellipsis}
.ocdb-pv{min-height:36px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-radius:8px;padding:0 8px;min-width:0;border:0;background:none;text-align:left;width:100%;color:inherit;font-size:13.5px}
button.ocdb-pv:hover:not(:disabled),div.ocdb-pv:hover{background:var(--hover)}
.ocdb-pv .ocdb-ce{font-size:13.5px;height:36px}
.ocdb-compact .ocdb-pk,.ocdb-compact .ocdb-pv{min-height:44px}
.ocdb-compact .ocdb-pv .ocdb-ce{font-size:16px;height:44px}
.ocdb-notes{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}
.ocdb-notes textarea{width:100%;min-height:120px;border:0;outline:none;background:none;resize:none;font-size:15px;line-height:1.7;color:var(--fg);padding:0;field-sizing:content;font-family:inherit}
.ocdb-notes textarea::placeholder{color:var(--fg-4)}
.ocdb-compact .ocdb-notes textarea{font-size:16px}

/* compact */
.ocdb-compact .ocdb-ib{width:38px;height:38px}
.ocdb-compact .ocdb-tab{height:44px}
.ocdb-compact .ocdb-search.show{width:110px;font-size:16px}
.ocdb-compact .ocdb-gw td:first-child,.ocdb-compact .ocdb-gw th:first-child{position:sticky;left:0;z-index:1;box-shadow:1px 0 0 var(--line)}
.ocdb-compact .ocdb-kcol{flex-basis:78%}
.ocdb-compact .ocdb-gal{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
.ocdb-compact .ocdb-ce{font-size:16px}
.ocdb-compact .ocdb-peekbtn{opacity:1;height:30px}
.ocdb-compact .ocdb-newrow,.ocdb-compact .ocdb-kadd{min-height:44px}
.ocdb-compact .ocdb-cev{padding:5px 6px}
.ocdb-compact .ocdb-chip{height:32px}
.ocdb-compact .ocdb-chip-x{width:28px;height:28px}

@keyframes ocdb-pop{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
@keyframes ocdb-fade{from{opacity:0}}
@keyframes ocdb-up{from{transform:translateY(100%)}to{transform:none}}
@keyframes ocdb-in{from{transform:translateX(24px);opacity:0}}
@keyframes ocdb-modal{from{opacity:0;transform:translate(-50%,-47%) scale(.98)}}
@media (prefers-reduced-motion:reduce){.ocdb *,.ocdb-layer,.ocdb-layer *{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

let injected = false;
export function ensureStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  if (document.querySelector("style[data-ocdb]")) return;
  const s = document.createElement("style");
  s.setAttribute("data-ocdb", "");
  s.textContent = CSS;
  document.head.appendChild(s);
}
