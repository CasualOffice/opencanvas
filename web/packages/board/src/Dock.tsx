// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// SCALE-02 / UX4-01, option A (docs/prototypes/v04-approved/board-toolbar.html): the board's bottom
// row. Tools left in priority order, the zoom pill right; tools leave from the end into "More",
// measured on the board's own width; the pill shrinks to a 100% button last. One Tab stop per
// group with arrow keys inside. "Tools on the left" (a personal setting in More) turns the tools
// into a rail that fits by the board's height.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Ellipsis, Frame as FrameIcon, Lock, LockOpen, Map as MapIcon, Maximize, Minus, PanelLeft, Plus, type LucideIcon } from "lucide-react";
import { fitRail, fitTools } from "./toolbar";
import { FrameItems } from "./frames/menu";

export type DockTool = [string, LucideIcon, string, string];
const SW = 1.75;

export interface DockProps {
  tools: DockTool[];
  tool: string;
  onTool: (t: string) => void;
  compact: boolean;
  rail: boolean;
  onRail: (on: boolean) => void;
  z: number;
  canOut: boolean;
  canIn: boolean;
  onZoom: (f: number) => void;
  onFit: () => void;
  mini: boolean;
  onMini: () => void;
  /** BRD-19 tool lock (editors only): the tool stays active after each shape. */
  lock?: boolean;
  onLock?: () => void;
  /** Double-click on a tool: pick it and lock it. */
  onToolLock?: (t: string) => void;
  /** BRD-21: the board's frames, listed in the zoom menu (Zoom to frame), and Present. */
  frames?: { id: string; name: string }[];
  onFrame?: (id: string) => void;
  onPresent?: () => void;
}

const remPx = () => (typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(document.documentElement).fontSize) : 0) || 16;

/** Moves focus among `items` for a roving group; returns the new index or null if `key` is not a move. */
function step(key: string, i: number, n: number, vertical: boolean): number | null {
  const next = vertical ? "ArrowDown" : "ArrowRight";
  const prev = vertical ? "ArrowUp" : "ArrowLeft";
  if (key === next) return (i + 1) % n;
  if (key === prev) return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/** A menu's own keys: arrows and Home / End move, Esc and Tab close and return focus to its button. */
function menuKeys(e: KeyboardEvent<HTMLDivElement>, close: () => void) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^='menuitem']")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  const j = e.key === "ArrowDown" ? (i + 1) % items.length : e.key === "ArrowUp" ? (i - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
  if (j >= 0) {
    e.preventDefault();
    e.stopPropagation();
    items[j]?.focus();
  } else if (e.key === "Escape" || e.key === "Tab") {
    if (e.key === "Escape") e.preventDefault();
    e.stopPropagation();
    close();
  }
}

export function Dock(p: DockProps) {
  const [box, setBox] = useState<[number, number]>([0, 0]);
  const dockRef = useRef<HTMLDivElement>(null);
  // Measured on the board itself (the dock's parent), not the window: side panels and embeds too.
  useLayoutEffect(() => {
    const el = dockRef.current?.closest<HTMLElement>(".ocbd");
    if (!el) return;
    const measure = () => {
      const r = remPx();
      setBox((b) => (b[0] === el.clientWidth / r && b[1] === el.clientHeight / r ? b : [el.clientWidth / r, el.clientHeight / r]));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const n = p.tools.length;
  const extra = p.onLock ? 1 : 0;
  const fit = p.rail ? { shown: fitRail(box[1], n, p.compact, extra), zoomFull: true } : fitTools(box[0], n, p.compact, extra);
  const shown = p.tools.slice(0, fit.shown);
  const hidden = p.tools.slice(fit.shown);
  const hiddenActive = hidden.find(([t]) => t === p.tool);

  const [menu, setMenu] = useState<"" | "more" | "zoom">("");
  const focusFirst = useRef(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const zoomBtn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menu && focusFirst.current) menuRef.current?.querySelector<HTMLButtonElement>("[role^='menuitem']")?.focus();
    focusFirst.current = false;
  }, [menu]);
  const open = (m: "more" | "zoom") => {
    focusFirst.current = true;
    setMenu((v) => (v === m ? "" : m));
  };
  const close = (refocus = true) => {
    const back = menu === "zoom" ? zoomBtn.current : moreRef.current;
    setMenu("");
    if (refocus) back?.focus();
  };

  // Roving tab stop in the tool bar (tools then More) and in the zoom pill.
  const [fi, setFi] = useState<number | null>(null);
  const activeIdx = shown.findIndex(([t]) => t === p.tool);
  const stop = Math.min(fi ?? (activeIdx >= 0 ? activeIdx : shown.length), shown.length);
  const barRef = useRef<HTMLDivElement>(null);
  const barKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button")];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const onMore = btns[i] === moreRef.current;
    if (onMore && (e.key === "Enter" || e.key === " " || e.key === (p.rail ? "ArrowRight" : "ArrowUp"))) {
      e.preventDefault();
      e.stopPropagation();
      open("more");
      return;
    }
    const j = step(e.key, i, btns.length, p.rail);
    if (j === null) return;
    e.preventDefault();
    e.stopPropagation();
    setFi(j);
    btns[j].focus();
  };
  const [zi, setZi] = useState(1);
  const zoomKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)")];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const j = step(e.key, i, btns.length, false);
    if (j === null) return;
    e.preventDefault();
    e.stopPropagation();
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button")];
    setZi(all.indexOf(btns[j]));
    btns[j].focus();
  };
  const zt = (i: number) => (fit.zoomFull ? (zi === i ? 0 : -1) : 0);
  const pct = `${Math.round(p.z * 100)}%`;
  const blurClose = (e: React.FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && (e.currentTarget.contains(to) || to === moreRef.current || to === zoomBtn.current)) return;
    if (to) close(false);
  };

  const MoreIcon = hiddenActive ? hiddenActive[1] : Ellipsis;
  return (
    <>
      <div ref={dockRef} className="ocbd-dock">
        <div ref={barRef} className="ocbd-tool" role="toolbar" aria-label="Board tools" aria-orientation={p.rail ? "vertical" : "horizontal"} onKeyDown={barKeys}>
          {shown.map(([t, I, label, key], i) => [
            i === 3 ? <span key="vs" className="ocbd-vs" /> : null,
            <button
              key={t}
              data-tool={t}
              className="ocbd-ib"
              tabIndex={stop === i ? 0 : -1}
              title={`${label} (${key})`}
              aria-label={label}
              aria-keyshortcuts={key}
              aria-pressed={p.tool === t}
              onFocus={() => setFi(i)}
              onClick={() => p.onTool(t)}
              onDoubleClick={() => p.onToolLock?.(t)}
            >
              <I size={16} strokeWidth={SW} />
              {p.lock && p.tool === t && t !== "select" && t !== "hand" ? (
                <span className="ocbd-lk" aria-hidden="true">
                  <Lock size={8} strokeWidth={3} />
                </span>
              ) : null}
            </button>,
          ])}
          <button
            ref={moreRef}
            className="ocbd-ib ocbd-more"
            tabIndex={stop === shown.length ? 0 : -1}
            title="More tools"
            aria-label={hiddenActive ? `More tools, ${hiddenActive[2]} selected` : "More tools"}
            aria-haspopup="menu"
            aria-expanded={menu === "more"}
            aria-pressed={hiddenActive ? true : undefined}
            onFocus={() => setFi(shown.length)}
            onClick={() => open("more")}
          >
            <MoreIcon size={16} strokeWidth={SW} />
          </button>
          {p.onLock ? (
            <>
              <span className="ocbd-vs" />
              <button
                className="ocbd-ib ocbd-lockbtn"
                tabIndex={-1}
                title="Keep tool active (Q)"
                aria-label="Keep tool active"
                aria-keyshortcuts="Q"
                aria-pressed={!!p.lock}
                onClick={p.onLock}
              >
                {p.lock ? <Lock size={16} strokeWidth={SW} /> : <LockOpen size={16} strokeWidth={SW} />}
              </button>
            </>
          ) : null}
        </div>

        <div className="ocbd-zoom" role="group" aria-label="Zoom" data-short={fit.zoomFull ? undefined : ""} onKeyDown={zoomKeys}>
          {fit.zoomFull ? (
            <>
              <button className="ocbd-ib" tabIndex={zt(0)} aria-label="Zoom out" onFocus={() => setZi(0)} onClick={() => p.onZoom(1 / 1.2)} disabled={!p.canOut}>
                <Minus size={14} strokeWidth={SW} />
              </button>
              <button className="ocbd-zl" tabIndex={zt(1)} title="Zoom to fit (Shift+1)" aria-label={`Zoom ${pct}. Zoom to fit`} aria-keyshortcuts="Shift+1" onFocus={() => setZi(1)} onClick={p.onFit}>
                {pct}
              </button>
              <button className="ocbd-ib" tabIndex={zt(2)} aria-label="Zoom in" onFocus={() => setZi(2)} onClick={() => p.onZoom(1.2)} disabled={!p.canIn}>
                <Plus size={14} strokeWidth={SW} />
              </button>
              <span className="ocbd-zs" />
              <button className="ocbd-ib" tabIndex={zt(4)} title="Minimap (M)" aria-label="Minimap" aria-keyshortcuts="M" aria-pressed={p.mini} onFocus={() => setZi(4)} onClick={p.onMini}>
                <MapIcon size={14} strokeWidth={SW} />
              </button>
              {p.frames?.length ? (
                <button ref={zoomBtn} className="ocbd-ib" tabIndex={zt(5)} title="Frames" aria-label="Frames" aria-haspopup="menu" aria-expanded={menu === "zoom"} onFocus={() => setZi(5)} onClick={() => open("zoom")}>
                  <FrameIcon size={14} strokeWidth={SW} />
                </button>
              ) : null}
            </>
          ) : (
            <button
              ref={zoomBtn}
              className="ocbd-zl"
              title={`Zoom ${pct}`}
              aria-label={`Zoom ${pct}`}
              aria-haspopup="menu"
              aria-expanded={menu === "zoom"}
              onClick={() => open("zoom")}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  open("zoom");
                }
              }}
            >
              <span aria-hidden="true">{pct}</span>
            </button>
          )}
        </div>
      </div>

      {menu === "more" ? (
        <div ref={menuRef} className="ocbd-menu ocbd-moremenu" role="menu" aria-label="More tools" onKeyDown={(e) => menuKeys(e, close)} onBlur={blurClose} onPointerDown={(e) => e.stopPropagation()}>
          {hidden.map(([t, I, label, key]) => (
            <button
              key={t}
              role="menuitemradio"
              aria-checked={p.tool === t}
              aria-label={label}
              aria-keyshortcuts={key}
              tabIndex={-1}
              className="ocbd-mi"
              onClick={() => {
                p.onTool(t);
                close();
              }}
            >
              <I size={16} strokeWidth={SW} />
              <span className="ocbd-mil">{label}</span>
              <kbd className="ocbd-kbd" aria-hidden="true">{key}</kbd>
            </button>
          ))}
          {hidden.length ? <span className="ocbd-ms" role="separator" /> : null}
          <button
            role="menuitemcheckbox"
            aria-checked={p.rail}
            tabIndex={-1}
            className="ocbd-mi"
            onClick={() => {
              p.onRail(!p.rail);
              close();
            }}
          >
            <PanelLeft size={16} strokeWidth={SW} />
            <span className="ocbd-mil">Tools on the left</span>
            {p.rail ? <Check size={16} strokeWidth={SW} aria-hidden="true" /> : null}
          </button>
        </div>
      ) : null}
      {menu === "zoom" ? (
        <div ref={menuRef} className="ocbd-menu ocbd-zoommenu" role="menu" aria-label="Zoom" onKeyDown={(e) => menuKeys(e, close)} onBlur={blurClose} onPointerDown={(e) => e.stopPropagation()}>
          <button role="menuitem" tabIndex={-1} className="ocbd-mi" disabled={!p.canIn} onClick={() => p.onZoom(1.2)}>
            <Plus size={16} strokeWidth={SW} />
            Zoom in
          </button>
          <button role="menuitem" tabIndex={-1} className="ocbd-mi" disabled={!p.canOut} onClick={() => p.onZoom(1 / 1.2)}>
            <Minus size={16} strokeWidth={SW} />
            Zoom out
          </button>
          <button role="menuitem" tabIndex={-1} className="ocbd-mi" onClick={() => (p.onFit(), close())}>
            <Maximize size={16} strokeWidth={SW} />
            Zoom to fit
          </button>
          <button role="menuitemcheckbox" aria-checked={p.mini} tabIndex={-1} className="ocbd-mi" onClick={() => (p.onMini(), close())}>
            <MapIcon size={16} strokeWidth={SW} />
            Minimap
          </button>
          <FrameItems frames={p.frames} onFrame={p.onFrame} onPresent={p.onPresent} close={close} />
        </div>
      ) : null}
    </>
  );
}
