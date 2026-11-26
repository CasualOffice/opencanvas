// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlignLeft, ArrowUpRight, BookOpen, ChartNoAxesColumn, Sigma, Bug, Calendar, CalendarDays, CircleChevronDown, CircleDot, ClipboardList, Database, FileSpreadsheet,
  Gauge, Handshake, Hash, Link2, ListChecks, ListTodo, Map as MapIcon, MessageSquare, PartyPopper, Repeat, SquareCheck,
  SquareKanban, Tags, Target, Text, UserPlus, UserRound, X, type LucideIcon, type LucideProps,
} from "lucide-react";
import { initials, type OcUser } from "@opencanvas/ui";
import type { FieldType } from "./types";

export const SW = 1.75;

/** Lucide icon with the house stroke width. */
export function Ic({ i: I, s = 16, ...rest }: { i: LucideIcon; s?: number } & Omit<LucideProps, "ref">) {
  return <I size={s} strokeWidth={SW} aria-hidden="true" {...rest} />;
}

export const DB_ICONS: Record<string, LucideIcon> = {
  "list-todo": ListTodo, bug: Bug, handshake: Handshake, "user-plus": UserPlus, target: Target, "calendar-days": CalendarDays,
  "book-open": BookOpen, "message-square": MessageSquare, map: MapIcon, "list-checks": ListChecks, repeat: Repeat,
  "party-popper": PartyPopper, "clipboard-list": ClipboardList, database: Database, "square-kanban": SquareKanban,
  "file-spreadsheet": FileSpreadsheet,
};
export const dbIcon = (name: string): LucideIcon => DB_ICONS[name] ?? Database;

export const TYPE_ICON: Record<FieldType, LucideIcon> = {
  title: Text, text: AlignLeft, status: CircleDot, select: CircleChevronDown, tags: Tags, person: UserRound,
  date: Calendar, number: Hash, checkbox: SquareCheck, url: Link2, progress: Gauge, formula: Sigma, relation: ArrowUpRight, rollup: ChartNoAxesColumn,
};

/** Relative luminance of `#rgb` / `#rrggbb`; null for anything else (as in the editor's lib/color). */
function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(h, 16);
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** White or black initials, whichever contrasts more with a person's colour (always ≥ 4.5:1). */
export function avatarInk(bg: string): string {
  const l = luminance(bg);
  if (l === null) return "#fff";
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#fff" : "#000";
}

export function Avatar({ u, size = "" }: { u: OcUser; size?: "" | "xs" | "md" }) {
  return (
    <span className={"ocdb-av " + size} style={{ background: u.color, color: avatarInk(u.color) }} aria-hidden="true">
      {u.avatar ? <img src={u.avatar} alt="" /> : initials(u.name)}
    </span>
  );
}

/* ------------------------------------------------------------ popover */

export type Anchor = HTMLElement | DOMRect;

interface PopProps {
  anchor: Anchor;
  compact: boolean;
  title?: string;
  onClose: () => void;
  alignRight?: boolean;
  children: ReactNode;
  label?: string;
  /** Escape runs this instead of `onClose` (e.g. to discard a field that was just added). */
  onEscape?: () => void;
}

/** Anchored popover on desktop, bottom sheet with scrim when compact. Portaled to body. */
export function Pop({ anchor, compact, title, onClose, alignRight, children, label, onEscape }: PopProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useLayoutEffect(() => {
    if (compact) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = anchor instanceof DOMRect ? anchor : anchor.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const pw = el.offsetWidth, ph = el.offsetHeight;
      let left = alignRight ? r.right - pw : r.left;
      let top = r.bottom + 6;
      if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
      left = Math.max(8, Math.min(left, vw - pw - 8));
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (ro && ref.current) ro.observe(ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, compact, alignRight]);

  // When the popover goes away with focus inside it (or lost to <body>), focus goes back to
  // the element that opened it, so keyboard users keep their place (and the cell its ring).
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      const a = document.activeElement;
      if (anchor instanceof HTMLElement && anchor.isConnected && (!a || a === document.body || node?.contains(a))) anchor.focus({ preventScroll: true });
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        (escape.current ?? close.current)();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (!(anchor instanceof DOMRect) && anchor.contains(t)) return;
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    if (!compact) document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, compact]);

  if (typeof document === "undefined") return null;
  if (compact) {
    return createPortal(
      <>
        <div className="ocdb-scrim ocdb-layer" onClick={onClose} />
        <div ref={ref} className="ocdb-sheet ocdb-layer ocdb-compact" role="dialog" aria-label={label ?? title}>
          <div className="ocdb-grab" />
          {title ? <div className="ocdb-sht">{title}</div> : null}
          {children}
        </div>
      </>,
      document.body,
    );
  }
  return createPortal(
    <div
      ref={ref}
      className="ocdb-pop ocdb-layer"
      role="dialog"
      aria-label={label ?? title}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------- modal */

interface ModalProps {
  compact: boolean;
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

export function Modal({ compact, title, sub, onClose, children, footer }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="ocdb-scrim ocdb-layer" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className={"ocdb-modal ocdb-layer" + (compact ? " ocdb-compact" : "")} role="dialog" aria-modal="true" aria-label={title} style={{ outline: "none" }}>
        {compact ? <div className="ocdb-grab" /> : null}
        <div className="ocdb-mhd">
          <div>
            <h2>{title}</h2>
            {sub ? <p>{sub}</p> : null}
          </div>
          <button className="ocdb-ib" onClick={onClose} aria-label="Close">
            <Ic i={X} />
          </button>
        </div>
        <div className="ocdb-mbd">{children}</div>
        <div className="ocdb-mft">{footer}</div>
      </div>
    </>,
    document.body,
  );
}

/* ---------------------------------------------------- committed input */

interface CommitInputProps {
  value: string;
  onCommit: (v: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  inputMode?: "decimal" | "text" | "url";
  ariaLabel?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}

/**
 * Text input that keeps a local draft while focused and commits on blur / Enter.
 * While not focused it always shows the shared (Yjs) value, so remote edits appear live.
 */
export function CommitInput({ value, onCommit, readOnly, placeholder, className, inputMode, ariaLabel, autoFocus, onEnter }: CommitInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const skip = useRef(false);
  /** The shared value when editing started; only a draft that differs from it is committed. */
  const base = useRef<string | null>(null);
  // Focused but untouched: follow the shared value (a remote edit, a paste into a range).
  if (draft !== null && draft === base.current && value !== base.current) {
    base.current = value;
    setDraft(value);
  }
  const commit = () => {
    if (draft !== null && draft !== base.current && draft !== value) onCommit(draft);
    base.current = null;
    setDraft(null);
  };
  return (
    <input
      className={className ?? "ocdb-ce"}
      value={draft ?? value}
      readOnly={readOnly}
      placeholder={placeholder}
      inputMode={inputMode}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      spellCheck={false}
      onFocus={() => {
        if (readOnly) return;
        base.current = value;
        setDraft(value);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (skip.current) {
          skip.current = false;
          setDraft(null);
          return;
        }
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          skip.current = true;
          (e.target as HTMLInputElement).blur();
          onEnter?.();
        } else if (e.key === "Escape") {
          skip.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
