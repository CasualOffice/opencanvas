// Popovers (desktop) that become bottom sheets in compact mode, modals, toasts.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ic } from "../icons";
import { toastStore, useStore } from "../lib/store";
import { readableOn } from "../lib/color";
import { placePopover } from "../lib/place";

export interface Shell {
  root: HTMLElement | null;
  compact: boolean;
}
export const ShellCtx = createContext<Shell>({ root: null, compact: false });
export const useShell = () => useContext(ShellCtx);

export type Anchor = Element | DOMRect | { left: number; right: number; top: number; bottom: number };

function rectOf(a: Anchor): { left: number; right: number; top: number; bottom: number } {
  return a instanceof Element ? a.getBoundingClientRect() : a;
}

/** Closes on outside pointer-down and Escape. */
function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void, ignore?: Element | null) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (ignore && ignore.contains(t)) return;
      cb.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cb.current();
      }
    };
    const id = window.setTimeout(() => document.addEventListener("pointerdown", down, true), 0);
    document.addEventListener("keydown", key, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [ref, ignore]);
}

const ITEM = "button:not(:disabled),[href],input,select,textarea,[tabindex]:not([tabindex='-1'])";

/**
 * Menu keyboard model (WAI-ARIA menu pattern): arrows move between items,
 * Home/End jump, Tab closes. Items are the menu's buttons.
 */
function menuKeys(e: React.KeyboardEvent<HTMLElement>, onClose: () => void) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEM)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const typing = (document.activeElement as HTMLElement | null)?.matches?.("input,textarea,select");
  const go = (n: number) => {
    e.preventDefault();
    items[(n + items.length) % items.length]?.focus();
  };
  if (e.key === "ArrowDown" && !typing) go(i + 1);
  else if (e.key === "ArrowUp" && !typing) go(i < 0 ? items.length - 1 : i - 1);
  else if (e.key === "Home" && !typing) go(0);
  else if (e.key === "End" && !typing) go(items.length - 1);
  else if (e.key === "Tab" && !typing && e.currentTarget.getAttribute("role") === "menu") {
    e.preventDefault();
    onClose();
  }
}

export function Popover(props: {
  anchor: Anchor;
  onClose(): void;
  children: ReactNode;
  title?: string;
  alignRight?: boolean;
  minWidth?: number;
  className?: string;
  /** Keep as a popover even in compact mode. */
  noSheet?: boolean;
  /**
   * `menu` (default): focus moves into the menu, arrows move between items, and
   * focus returns to the opener on close. `listbox`: a suggestion list driven
   * from the editor (slash, mentions); focus stays where the person types.
   * `dialog`: a small form (link editor, pickers).
   */
  kind?: "menu" | "listbox" | "dialog";
  /** Override whether focus moves into the popover on open (default: not for listboxes). */
  autoFocus?: boolean;
}) {
  const { root, compact } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const sheet = compact && !props.noSheet;
  const kind = props.kind ?? "menu";
  const ownsFocus = props.autoFocus ?? kind !== "listbox";
  const opener = useRef<HTMLElement | null>(null);
  useDismiss(ref, props.onClose, props.anchor instanceof Element ? props.anchor : null);

  // Move focus in on open and give it back to whoever opened us on close.
  useEffect(() => {
    if (!ownsFocus) return;
    opener.current = (props.anchor instanceof HTMLElement ? props.anchor : null) ?? (document.activeElement as HTMLElement | null);
    const t = window.requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(kind === "menu" ? ".mi:not(:disabled), button:not(:disabled)" : ITEM);
      first?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(t);
      const o = opener.current;
      // Only when focus would otherwise be lost (inside the closed popover or on <body>).
      window.requestAnimationFrame(() => {
        const a = document.activeElement;
        if (o && o.isConnected && (!a || a === document.body || !a.isConnected)) o.focus({ preventScroll: true });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ARIA roles for the items (buttons inside a menu are menu items).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || sheet) return;
    if (kind === "menu") el.querySelectorAll(".mi").forEach((b) => b.setAttribute("role", "menuitem"));
    if (kind === "listbox")
      el.querySelectorAll(".mi, .sgrid > button").forEach((b) => {
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", String(b.classList.contains("on")));
        b.setAttribute("tabindex", "-1");
      });
  });

  useLayoutEffect(() => {
    if (sheet || !root || !ref.current) return;
    const ar = root.getBoundingClientRect();
    const r = rectOf(props.anchor);
    const el = ref.current;
    const local = { left: r.left - ar.left, right: r.right - ar.left, top: r.top - ar.top, bottom: r.bottom - ar.top };
    const next = placePopover(local, { width: ar.width, height: ar.height }, { width: el.offsetWidth, height: el.scrollHeight }, props.alignRight);
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next));
  }, [root, sheet, props.anchor, props.alignRight, props.children]);

  if (!root) return null;
  const role = kind === "listbox" ? "listbox" : kind === "dialog" ? "dialog" : "menu";
  if (sheet) {
    return createPortal(
      <>
        <div className="scrim" onPointerDown={(e) => e.preventDefault()} />
        <div className={"sheet " + (props.className ?? "")} ref={ref} role="dialog" aria-label={props.title} onKeyDown={(e) => menuKeys(e, props.onClose)}>
          <div className="grab" />
          {props.title ? <div className="sh-t">{props.title}</div> : null}
          {props.children}
        </div>
      </>,
      root,
    );
  }
  return createPortal(
    <div
      className={"pop " + (props.className ?? "")}
      ref={ref}
      role={role}
      aria-label={props.title}
      onKeyDown={kind === "listbox" ? undefined : (e) => menuKeys(e, props.onClose)}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth: props.minWidth, maxHeight: pos?.maxHeight }}
    >
      {props.children}
    </div>,
    root,
  );
}

export function Modal(props: { onClose(): void; children: ReactNode; wide?: boolean; label?: string; dismissable?: boolean }) {
  const { root } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.dismissable !== false) {
        e.stopPropagation();
        close.current();
      }
      // Keep Tab inside the dialog (WCAG 2.4.3 focus order for modals).
      if (e.key === "Tab" && ref.current) {
        const els = [...ref.current.querySelectorAll<HTMLElement>(ITEM)].filter((x) => x.offsetParent !== null);
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    // In priority order (a selector list would pick whichever comes first in the DOM, i.e. the close button).
    const el = ref.current;
    const f = el ? (["[data-autofocus]", "input,textarea", "button.primary", "button"].map((q) => [...el.querySelectorAll<HTMLElement>(q)].find((x) => x.offsetParent !== null)).find(Boolean) ?? null) : null;
    f?.focus();
    return () => {
      document.removeEventListener("keydown", key, true);
      if (opener?.isConnected) window.requestAnimationFrame(() => opener.focus({ preventScroll: true }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!root) return null;
  return createPortal(
    <>
      <div className="scrim" onClick={() => props.dismissable !== false && props.onClose()} />
      <div className={"modal" + (props.wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={props.label} ref={ref}>
        {props.children}
      </div>
    </>,
    root,
  );
}

export function ModalHead({ title, sub, onClose, icon, tone }: { title: string; sub?: string; onClose?: () => void; icon?: string; tone?: string }) {
  return (
    <div className="mhd">
      {icon ? (
        <span className={`cic tone-${tone ?? "gray"}`} style={{ width: 36, height: 36, borderRadius: 10 }}>
          <Ic name={icon} />
        </span>
      ) : null}
      <div>
        <h2>{title}</h2>
        {sub ? <p>{sub}</p> : null}
      </div>
      {onClose ? (
        <button className="ib" onClick={onClose} aria-label="Close">
          <Ic name="x" />
        </button>
      ) : null}
    </div>
  );
}

export function Avatar({ name, color, avatar, cls = "sm" }: { name: string; color: string; avatar?: string | null; cls?: string }) {
  const p = name.trim().split(/\s+/);
  const ini = ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  return (
    <span className={"av " + cls} style={{ background: color, color: readableOn(color) }} aria-hidden>
      {avatar ? <img src={avatar} alt="" /> : ini}
    </span>
  );
}

export function Toasts() {
  const t = useStore(toastStore);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {t ? (
        <div className="toast" key={t.id}>
          {t.avatar ? <Avatar name={t.avatar.name} color={t.avatar.color} cls="xs" /> : t.icon ? <Ic name={t.icon} size={14} /> : null}
          <span>{t.text}</span>
          {t.action ? (
            <button
              onClick={() => {
                t.action!.run();
                toastStore.set(null);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
