// Hover cards for people (docs/21 "Telling people apart"): mention chips, database assignee
// cells, comment authors and anything else marked `data-person-id`. WCAG 2.2 (1.4.13): the
// card opens on hover *and* on keyboard focus (or with the caret right after a mention while
// editing), stays while the pointer is over it, and Escape dismisses it.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { foldName, relationNote, secondLine, timeAgo } from "@opencanvas/ui";
import type { People } from "../lib/people";
import { readableOn } from "../lib/color";
import { Ic } from "../icons";

const CARD_ID = "oc-person-card";
const OPEN_MS = 350;
const CLOSE_MS = 200;

interface Open {
  id: string;
  el: HTMLElement;
  rect: DOMRect;
}

/** The person element at or around `t`: a chip/cell marker, or a focused cell holding one. */
function personEl(t: EventTarget | null): HTMLElement | null {
  if (!(t instanceof Element)) return null;
  const hit = t.closest<HTMLElement>("[data-person-id]");
  if (hit) return hit;
  if (t instanceof HTMLElement && t.matches("[role=gridcell], td, [role=button].ocdb-card, .ocdb-card")) return t.querySelector<HTMLElement>("[data-person-id]");
  return null;
}

/** While editing: the mention chip right before a collapsed caret, if any. */
function chipBeforeCaret(root: HTMLElement): HTMLElement | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) return null;
  const { anchorNode: n, anchorOffset: o } = sel;
  let prev: Node | null = null;
  if (n.nodeType === Node.TEXT_NODE) prev = o === 0 ? n.previousSibling : null;
  else prev = n.childNodes[o - 1] ?? null;
  return prev instanceof HTMLElement && prev.matches(".mention[data-person-id]") ? prev : null;
}

export function PersonCards({ root, people }: { root: HTMLElement | null; people: People }) {
  const [open, setOpen] = useState<Open | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const openRef = useRef<Open | null>(null);
  openRef.current = open;
  useSyncExternalStore(people.version.subscribe, people.version.get);

  useEffect(() => {
    if (!root) return;
    const show = (el: HTMLElement, now = false) => {
      window.clearTimeout(timer.current);
      const id = el.dataset.personId;
      if (!id) return;
      const go = () => setOpen({ id, el, rect: el.getBoundingClientRect() });
      if (now) go();
      else timer.current = window.setTimeout(go, OPEN_MS);
    };
    const hide = (now = false) => {
      window.clearTimeout(timer.current);
      if (now) setOpen(null);
      else timer.current = window.setTimeout(() => setOpen(null), CLOSE_MS);
    };
    const over = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(`#${CARD_ID}`)) return window.clearTimeout(timer.current);
      const el = t?.closest?.<HTMLElement>("[data-person-id]");
      if (el) {
        if (openRef.current?.el !== el) show(el);
        else window.clearTimeout(timer.current);
      }
    };
    const out = (e: MouseEvent) => {
      const from = (e.target as Element | null)?.closest?.(`[data-person-id], #${CARD_ID}`);
      const to = (e.relatedTarget as Element | null)?.closest?.(`[data-person-id], #${CARD_ID}`);
      if (from && from !== to) hide();
    };
    const focusIn = (e: FocusEvent) => {
      const el = personEl(e.target);
      if (el) show(el, true);
    };
    const focusOut = (e: FocusEvent) => {
      if (personEl(e.target) && !personEl(e.relatedTarget)) hide(true);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openRef.current) {
        hide(true);
        e.stopPropagation();
      }
    };
    const caret = () => {
      const pm = root.querySelector<HTMLElement>(".ProseMirror[contenteditable=true]");
      if (!pm) return;
      const chip = chipBeforeCaret(pm);
      if (chip) show(chip, true);
      else if (openRef.current?.el.matches(".ProseMirror .mention") && !openRef.current.el.matches(":hover")) hide(true);
    };
    root.addEventListener("mouseover", over);
    root.addEventListener("mouseout", out);
    root.addEventListener("focusin", focusIn);
    root.addEventListener("focusout", focusOut);
    root.addEventListener("keydown", key, true);
    document.addEventListener("selectionchange", caret);
    return () => {
      window.clearTimeout(timer.current);
      root.removeEventListener("mouseover", over);
      root.removeEventListener("mouseout", out);
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", focusOut);
      root.removeEventListener("keydown", key, true);
      document.removeEventListener("selectionchange", caret);
    };
  }, [root]);

  // The trigger describes itself with the card while it is open.
  useEffect(() => {
    if (!open) return;
    const el = open.el;
    const before = el.getAttribute("aria-describedby");
    el.setAttribute("aria-describedby", CARD_ID);
    return () => {
      if (before) el.setAttribute("aria-describedby", before);
      else el.removeAttribute("aria-describedby");
    };
  }, [open]);

  if (!open || !open.el.isConnected) return null;
  const p = people.get(open.id);
  if (p.pending) return null;
  const hidden = p.relation === "hidden";
  const dup = !hidden && people.isDuplicate(p.name);
  const note = relationNote(p);
  const second = hidden ? null : p.detail ?? (dup ? secondLine(p, { showEmail: people.cfg.showEmail }) : null);
  const top = Math.min(open.rect.bottom + 6, window.innerHeight - 140);
  const left = Math.max(8, Math.min(open.rect.left, window.innerWidth - 288));
  return (
    <div
      id={CARD_ID}
      role="tooltip"
      className={"pcard" + (p.deactivated ? " former" : "")}
      style={{ top, left }}
      onMouseEnter={() => window.clearTimeout(timer.current)}
      onMouseLeave={() => setOpen(null)}
      data-dup={dup || undefined}
    >
      <span className="av lg" style={{ background: p.color, color: readableOn(p.color) }} aria-hidden="true">
        {hidden ? <Ic name="user-round" size={18} /> : p.avatar ? <img src={p.avatar} alt="" /> : people.initialsOf(p.id, p.name)}
      </span>
      <span className="pc-body">
        <b className="pc-name">{p.name}</b>
        {second ? <span className="pc-detail">{second}</span> : null}
        {people.cfg.showEmail && p.email && p.email !== second ? <span className="pc-detail">{p.email}</span> : null}
        {note ? <span className="pc-note">{note}</span> : null}
        {!hidden && p.lastSeen && foldName(second ?? "").indexOf("last here") < 0 ? <span className="pc-seen">Last here {timeAgo(p.lastSeen)}</span> : null}
      </span>
    </div>
  );
}
