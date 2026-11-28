// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// BRD-18: the board's context menu (right-click, long-press, Shift+F10, the toolbar's More), its
// phone sheet, the keyboard shortcut list (?) and the link popover. Approved prototype:
// docs/prototypes/board-ux-approved/board-ux.html, decisions 1, 3 and 14.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, X, type LucideIcon } from "lucide-react";

const SW = 1.75;

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  /** Shortcut in the portable form "Shift+Mod+K" (Mod is ⌘ on Apple, Ctrl elsewhere). */
  kbd?: string;
  run?: () => void;
  disabled?: boolean;
  /** Why it is disabled: the tooltip. */
  why?: string;
  danger?: boolean;
  sub?: MenuEntry[];
  /** A checkbox item. */
  check?: boolean;
}
export type MenuEntry = MenuItem | "-" | { head: string };
const isItem = (e: MenuEntry): e is MenuItem => typeof e === "object" && "label" in e;

const APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
/** "Shift+Mod+K" as people read it on this platform: ⇧⌘K or Shift+Ctrl+K. */
export function kbdLabel(k: string): string {
  if (!APPLE) return k.replace(/Mod\+/g, "Ctrl+");
  return k.replace(/Shift\+/g, "⇧").replace(/Alt\+/g, "⌥").replace(/Mod\+/g, "⌘").replace(/^Delete$/, "⌫");
}
/** The same shortcut for `aria-keyshortcuts`. */
const ariaKeys = (k: string) => k.replace(/Mod\+/g, APPLE ? "Meta+" : "Control+");

/** Drops separators at the ends and doubled ones (items hidden for this selection leave gaps). */
function tidy(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of items) if (e !== "-" || (out.length && out[out.length - 1] !== "-")) out.push(e);
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

function Items({ items, open, onItem, onEnter }: { items: MenuEntry[]; open: number | null; onItem: (i: number, el: HTMLElement) => void; onEnter: (i: number, el: HTMLElement) => void }) {
  return (
    <>
      {items.map((e, i) => {
        if (e === "-") return <span key={i} className="ocbd-msep" role="separator" />;
        if (!isItem(e)) return <div key={i} className="ocbd-mh">{e.head}</div>;
        const I = e.icon;
        return (
          <button
            key={i}
            data-mi={i}
            className={"ocbd-mi" + (e.danger ? " danger" : "") + (open === i ? " open" : "")}
            role={e.check !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={e.check !== undefined ? e.check : undefined}
            aria-disabled={e.disabled || undefined}
            aria-haspopup={e.sub ? "menu" : undefined}
            aria-expanded={e.sub ? open === i : undefined}
            aria-keyshortcuts={e.kbd ? ariaKeys(e.kbd) : undefined}
            title={e.disabled ? e.why : undefined}
            tabIndex={-1}
            onClick={(ev) => onItem(i, ev.currentTarget)}
            onPointerEnter={(ev) => ev.pointerType === "mouse" && onEnter(i, ev.currentTarget)}
          >
            {e.check !== undefined ? <span className="ocbd-ck">{e.check ? <Check size={14} strokeWidth={SW} /> : null}</span> : I ? <I size={16} strokeWidth={SW} /> : <span className="ocbd-ck" />}
            <span className="ocbd-mil">{e.label}</span>
            {e.sub ? <ChevronRight size={14} strokeWidth={SW} className="ocbd-chev" aria-hidden="true" /> : e.kbd ? <kbd className="ocbd-kbd" aria-hidden="true">{kbdLabel(e.kbd)}</kbd> : null}
          </button>
        );
      })}
    </>
  );
}

/** Arrow keys, Home and End move between a menu's items; returns true when it handled the key. */
function moveFocus(e: KeyboardEvent<HTMLDivElement>): boolean {
  const bs = [...e.currentTarget.querySelectorAll<HTMLElement>(":scope > [role^='menuitem'], :scope > .ocbd-quick > button")];
  const i = bs.indexOf(document.activeElement as HTMLElement);
  const j = e.key === "ArrowDown" ? (i + 1) % bs.length : e.key === "ArrowUp" ? (i - 1 + bs.length) % bs.length : e.key === "Home" ? 0 : e.key === "End" ? bs.length - 1 : -1;
  if (j < 0 || !bs.length) return false;
  e.preventDefault();
  e.stopPropagation();
  bs[j].focus();
  return true;
}
const firstItem = (el: HTMLElement | null) => el?.querySelector<HTMLElement>(":scope > [role^='menuitem']:not([aria-disabled='true'])") ?? el?.querySelector<HTMLElement>(":scope > [role^='menuitem']");

export interface QuickAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  danger?: boolean;
}

/**
 * The context menu. `at` is the click point inside the board (the menu is kept inside it), `sheet`
 * draws it as a bottom sheet with `quick` actions on top (phones, long-press). `onClose(refocus)`
 * closes it; items close it first and then run, so focus is back on the board when they act.
 */
export function ContextMenu(p: { items: MenuEntry[]; at: [number, number]; sheet: boolean; label: string; title?: ReactNode; quick?: QuickAction[]; onClose: (refocus: boolean) => void }) {
  const [stack, setStack] = useState<{ items: MenuEntry[]; label: string }[]>([]);
  const items = tidy(stack.length ? stack[stack.length - 1].items : p.items);
  const [sub, setSub] = useState<{ i: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<[number, number]>(p.at);
  const [subPos, setSubPos] = useState<[number, number] | null>(null);
  const focusSub = useRef(false);

  // Kept inside the board: measured after the first layout.
  useLayoutEffect(() => {
    const el = ref.current, host = el?.offsetParent as HTMLElement | null;
    if (!el || !host || p.sheet) return;
    const W = host.clientWidth, H = host.clientHeight;
    const x = Math.max(8, Math.min(p.at[0], W - el.offsetWidth - 8)), y = Math.max(8, Math.min(p.at[1], H - el.offsetHeight - 8));
    if (x !== pos[0] || y !== pos[1]) setPos([x, y]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.at[0], p.at[1], p.sheet]);
  useLayoutEffect(() => {
    const el = ref.current, s = subRef.current, host = el?.offsetParent as HTMLElement | null;
    if (!sub || !el || !s || !host) return setSubPos(null);
    const W = host.clientWidth, H = host.clientHeight;
    let x = el.offsetLeft + el.offsetWidth - 4;
    if (x + s.offsetWidth > W - 8) x = Math.max(8, el.offsetLeft - s.offsetWidth + 4);
    const y = Math.max(8, Math.min(el.offsetTop + sub.top - 5, H - s.offsetHeight - 8));
    setSubPos([x, y]);
  }, [sub, pos]);
  useEffect(() => {
    firstItem(ref.current)?.focus({ preventScroll: true });
  }, [stack.length]);
  useEffect(() => {
    if (sub && focusSub.current) firstItem(subRef.current)?.focus({ preventScroll: true });
    focusSub.current = false;
  }, [sub, subPos]);

  const runItem = (it: MenuItem) => {
    if (it.disabled) return;
    p.onClose(true);
    it.run?.();
  };
  const openSub = (i: number, el: HTMLElement, focus: boolean) => {
    const it = items[i];
    if (!isItem(it) || !it.sub || it.disabled) return;
    if (p.sheet) {
      setStack((s) => [...s, { items: it.sub!, label: it.label }]);
      return;
    }
    focusSub.current = focus;
    setSub({ i, top: el.offsetTop });
  };
  const onItem = (i: number, el: HTMLElement) => {
    const it = items[i];
    if (!isItem(it)) return;
    if (it.sub) openSub(i, el, true);
    else runItem(it);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (moveFocus(e)) return;
    const cur = document.activeElement as HTMLElement | null;
    const i = Number(cur?.getAttribute("data-mi") ?? -1);
    const it = i >= 0 ? items[i] : undefined;
    if (e.key === "ArrowRight" && it && isItem(it) && it.sub) {
      e.preventDefault();
      e.stopPropagation();
      openSub(i, cur!, true);
    } else if (e.key === "ArrowLeft" && stack.length) {
      e.preventDefault();
      e.stopPropagation();
      setStack((s) => s.slice(0, -1));
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      p.onClose(true);
    } else if ((e.key === "Enter" || e.key === " ") && cur?.closest(".ocbd-ctx") === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      cur.click();
    }
  };
  const subItems = sub ? (() => {
    const it = items[sub.i];
    return isItem(it) && it.sub ? tidy(it.sub) : [];
  })() : [];
  const subKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (moveFocus(e)) return;
    if (e.key === "ArrowLeft" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const back = ref.current?.querySelector<HTMLElement>(`[data-mi="${sub?.i}"]`);
      setSub(null);
      back?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      p.onClose(true);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      (document.activeElement as HTMLElement | null)?.click();
    }
  };
  const head = stack.length ? stack[stack.length - 1].label : null;
  return (
    <>
      <div
        className={"ocbd-scrim" + (p.sheet ? " dim" : "")}
        onPointerDown={(e) => {
          e.stopPropagation();
          p.onClose(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          p.onClose(true);
        }}
      />
      <div
        ref={ref}
        className={"ocbd-menu ocbd-ctx" + (p.sheet ? " sheet" : "")}
        role="menu"
        aria-label={head ?? p.label}
        style={p.sheet ? undefined : { left: pos[0], top: pos[1] }}
        onKeyDown={keys}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {p.sheet ? <span className="ocbd-grab" aria-hidden="true" /> : null}
        {p.sheet && head ? (
          <button className="ocbd-mi ocbd-back" role="menuitem" tabIndex={-1} onClick={() => setStack((s) => s.slice(0, -1))}>
            <ChevronLeft size={16} strokeWidth={SW} />
            <b>{head}</b>
          </button>
        ) : p.sheet && p.title ? (
          <div className="ocbd-sheet-h">{p.title}</div>
        ) : null}
        {p.sheet && !head && p.quick?.length ? (
          <div className="ocbd-quick">
            {p.quick.map((q) => (
              <button key={q.label} className={q.danger ? "danger" : undefined} aria-label={q.label} tabIndex={-1} onClick={() => (p.onClose(true), q.run())}>
                <q.icon size={22} strokeWidth={1.5} />
                <span aria-hidden="true">{q.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <Items items={items} open={sub?.i ?? null} onItem={onItem} onEnter={(i, el) => {
          const it = items[i];
          if (isItem(it) && it.sub && !it.disabled) openSub(i, el, false);
          else setSub(null);
        }} />
      </div>
      {sub && subItems.length ? (
        <div
          ref={subRef}
          className="ocbd-menu ocbd-ctx ocbd-sub"
          role="menu"
          aria-label={(items[sub.i] as MenuItem).label}
          style={{ left: subPos?.[0] ?? -9999, top: subPos?.[1] ?? 0 }}
          onKeyDown={subKeys}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <Items items={subItems} open={null} onItem={(i) => {
            const it = subItems[i];
            if (isItem(it)) runItem(it);
          }} onEnter={() => {}} />
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------ shortcuts */

/** The keyboard map (3b). `n`: new in the whiteboard UX pass. */
export const KEYMAP: [string, [string, string, boolean?][]][] = [
  ["Tools", [["V", "Select"], ["N", "Sticky note"], ["P", "Pen"], ["T", "Text"], ["R", "Rectangle"], ["A", "Arrow (connector)"], ["O", "Ellipse"], ["D", "Diamond"], ["F", "Frame", true], ["H, or hold Space", "Pan"], ["Q", "Keep the tool active (tool lock)", true], ["Double-click a tool", "Pick it and keep it active", true], ["Escape", "Back to Select, release the lock"], ["Tool, then Enter", "Place the tool's shape in the middle of the view"]]],
  ["Edit", [["Mod+Z / Shift+Mod+Z", "Undo / redo"], ["Mod+X, Mod+C, Mod+V", "Cut, copy, paste"], ["Mod+D", "Duplicate"], ["Delete", "Delete"], ["Mod+A", "Select all"], ["Enter", "Edit text; rename a frame (also F2)", true], ["Shift+Mod+C", "Copy as PNG", true], ["Shift+Mod+K", "Add link", true]]],
  ["Arrange", [["Mod+] / Mod+[", "Forward / backward"], ["Shift+Mod+] / Shift+Mod+[", "To front / to back"], ["Mod+G / Shift+Mod+G", "Group / ungroup"], ["Alt+Shift+← → ↑ ↓", "Align left, right, top, bottom", true], ["Shift+F", "Wrap in frame", true], ["Shift+Mod+L", "Lock / unlock", true], ["Shift+R / Alt+Shift+R", "Rotate 15° clockwise / anticlockwise", true], ["Alt+S", "Style panel", true]]],
  ["Select and move", [["Tab / Shift+Tab", "Next / previous shape"], ["Arrows, Shift+arrows", "Move 1 / 10"], ["Alt+arrows", "Resize"], ["Shift+click", "Add or remove from the selection"], ["Drag on empty canvas", "Select shapes fully inside; with Alt, any it touches", true], ["Alt while dragging", "Move, resize or rotate without snapping", true], ["Shift while resizing", "Keep proportions"], ["Shift+F10, Menu key", "Context menu", true]]],
  ["View", [["Mod+= / Mod+-, Mod+wheel", "Zoom in / out"], ["Shift+1", "Zoom to fit"], ["Shift+2", "Zoom to selection"], ["Shift+0", "Zoom to 100%"], ["Shift+P", "Present frames", true], ["M", "Minimap"], ["Shift+D", "Open as diagram"], ["?", "This list"]]],
];

export function KeysDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <>
      <div className="ocbd-scrim dim" onPointerDown={(e) => (e.stopPropagation(), onClose())} />
      <div
        className="ocbd-dlg ocbd-keys"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="ocbd-dlg-h">
          <h3>Keyboard shortcuts</h3>
          <button ref={ref} className="ocbd-ib" aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={SW} />
          </button>
        </div>
        <table>
          <tbody>
            {KEYMAP.flatMap(([g, rows]) => [
              <tr key={g}>
                <th colSpan={2}>{g}</th>
              </tr>,
              ...rows.map(([k, d, n]) => (
                <tr key={g + k + d}>
                  <td>{kbdLabel(k)}</td>
                  <td>
                    {d}
                    {n ? <span className="ocbd-new"> New</span> : null}
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- link */

/** Add or edit a shape's link. `onSave(null)` removes it; a link that is not http(s) or mailto is refused. */
export function LinkPop({ at, value, onSave, onClose, check }: { at: [number, number]; value: string; onSave: (v: string | null) => void; onClose: () => void; check: (v: string) => string | null }) {
  const [v, setV] = useState(value);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const save = () => {
    if (!v.trim()) return onSave(null);
    const ok = check(v);
    if (!ok) return setErr("Use a link that starts with https://, http:// or mailto:");
    onSave(ok);
  };
  return (
    <>
      <div className="ocbd-scrim" onPointerDown={(e) => (e.stopPropagation(), onClose())} />
      <div className="ocbd-linkpop" role="dialog" aria-label="Link" style={{ left: at[0], top: at[1] }} onPointerDown={(e) => e.stopPropagation()}>
        <label>
          <span>Link</span>
          <input
            ref={ref}
            value={v}
            placeholder="https://"
            aria-invalid={err ? true : undefined}
            onChange={(e) => (setV(e.target.value), setErr(""))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </label>
        {err ? <p role="alert">{err}</p> : null}
        <div className="ocbd-linkpop-a">
          {value ? <button className="ocbd-btn" onClick={() => onSave(null)}>Remove</button> : null}
          <button className="ocbd-btn pri" onClick={save}>Save</button>
        </div>
      </div>
    </>
  );
}
