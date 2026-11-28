// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Shared pieces: type tiles (owner decision 8), avatars, toasts and dialogs.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Database, FileText, Shapes, Sheet, X } from "lucide-react";
import { initials, typeOf, type FileType } from "./api";

const TYPE_ICON = { document: FileText, spreadsheet: Sheet, whiteboard: Shapes, database: Database };

export function TypeIcon({ type, size = 16 }: { type: FileType | string; size?: number }) {
  const I = TYPE_ICON[(type as FileType) in TYPE_ICON ? (type as FileType) : "document"];
  return <I size={size} aria-hidden="true" />;
}

/** The type's tile: icon and colour, named for screen readers. */
export function TypeTile({ type, size = "md" }: { type: FileType | string; size?: "sm" | "md" | "lg" }) {
  const t = typeOf(type);
  const dim = size === "sm" ? "1.125rem" : size === "lg" ? "2.5rem" : "1.375rem";
  const r = size === "lg" ? ".625rem" : ".375rem";
  return (
    <span className={`ctile ${t.tone}`} style={{ width: dim, height: dim, borderRadius: r }} role="img" aria-label={t.label}>
      <TypeIcon type={type} size={size === "lg" ? 20 : 14} />
    </span>
  );
}

export function Avatar({ name, color, small }: { name: string; color?: string; small?: boolean }) {
  return (
    <span className={`av ${small ? "s" : ""}`} style={{ background: color || "var(--u0)" }} title={name}>
      {initials(name)}
    </span>
  );
}

type ToastFn = (text: ReactNode, action?: { label: string; run: () => void }) => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ text: ReactNode; action?: { label: string; run: () => void }; key: number } | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback<ToastFn>((text, action) => {
    window.clearTimeout(timer.current);
    setT({ text, action, key: Date.now() });
    timer.current = window.setTimeout(() => setT(null), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite" className="sr-live">
        {t && (
          <div className="toast app-toast" role="status" key={t.key}>
            {t.text}
            {t.action && (
              <button
                className="btn sec"
                onClick={() => {
                  t.action!.run();
                  setT(null);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

/** A modal dialog: focus moves in, Escape and the backdrop close it, focus returns after. */
export function Modal({
  title,
  sub,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input,select,button:not([data-close]),[tabindex='0']");
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>("input,select,button,textarea,a[href],[tabindex='0']")].filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1]!.focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0]!.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="mask app-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dlg ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dlg-h">
          <div style={{ flex: 1 }}>
            <h3>{title}</h3>
            {sub && <p>{sub}</p>}
          </div>
          <button className="btn ic" data-close aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="dlg-b">{children}</div>
        {footer && <div className="dlg-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="emp" style={{ height: "auto", padding: "3rem 1rem" }}>
      <span className="art">{icon}</span>
      <b>{title}</b>
      <p>{text}</p>
      {children && <div className="acts">{children}</div>}
    </div>
  );
}

export function Brand({ org }: { org?: string }) {
  return (
    <div className="brand">
      <span className="org" style={{ padding: 0, width: "auto" }}>
        <span className="ot t-blue" style={{ width: "2rem", height: "2rem", fontSize: ".8125rem" }}>
          {(org || "O").slice(0, 1).toUpperCase()}
        </span>
      </span>
      <span className="brand-t">
        <b>{org || "OpenCanvas Workspace"}</b>
        <small>OpenCanvas Workspace by CasualOffice</small>
      </span>
    </div>
  );
}
