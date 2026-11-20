// Popovers (desktop) that become bottom sheets in compact mode, modals, toasts.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ic } from "../icons";
import { toastStore, useStore } from "../lib/store";

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
}) {
  const { root, compact } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const sheet = compact && !props.noSheet;
  useDismiss(ref, props.onClose, props.anchor instanceof Element ? props.anchor : null);

  useLayoutEffect(() => {
    if (sheet || !root || !ref.current) return;
    const ar = root.getBoundingClientRect();
    const r = rectOf(props.anchor);
    const pw = ref.current.offsetWidth;
    const ph = ref.current.offsetHeight;
    let left = (props.alignRight ? r.right - pw : r.left) - ar.left;
    let top = r.bottom - ar.top + 6;
    if (top + ph > ar.height - 8) top = Math.max(8, r.top - ar.top - ph - 6);
    left = Math.max(8, Math.min(left, ar.width - pw - 8));
    setPos({ left, top });
  }, [root, sheet, props.anchor, props.alignRight, props.children]);

  if (!root) return null;
  if (sheet) {
    return createPortal(
      <>
        <div className="scrim" onPointerDown={(e) => e.preventDefault()} />
        <div className={"sheet " + (props.className ?? "")} ref={ref} role="dialog" aria-label={props.title}>
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
      role="menu"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth: props.minWidth }}
    >
      {props.children}
    </div>,
    root,
  );
}

export function Modal(props: { onClose(): void; children: ReactNode; wide?: boolean; label?: string; dismissable?: boolean }) {
  const { root } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.dismissable !== false) props.onClose();
    };
    document.addEventListener("keydown", key);
    const f = ref.current?.querySelector<HTMLElement>("[data-autofocus],button.primary,input,button");
    f?.focus();
    return () => document.removeEventListener("keydown", key);
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
    <span className={"av " + cls} style={{ background: color }} aria-hidden>
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
