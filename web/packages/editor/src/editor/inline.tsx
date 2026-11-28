// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Inline additions (UX-02, ADR-027): the `textColor` mark (a token palette that holds up in
// light and dark) and the `dateMention` node (an inline date chip). Both are part of the file
// format (docs/15 §4): names and attrs are fixed.
import { Mark, Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Ic } from "../icons";
import { createStore, useStore } from "../lib/store";

// ---------- text colour ----------

/** Text colours: the tone tokens (`--<tone>-fg`), AA on the page in both themes. */
export const TEXT_COLORS = ["gray", "red", "amber", "green", "blue", "purple", "pink"] as const;
export type TextColor = (typeof TEXT_COLORS)[number];
export const COLOR_NAME: Record<TextColor, string> = { gray: "Gray", red: "Red", amber: "Amber", green: "Green", blue: "Blue", purple: "Purple", pink: "Pink" };
const isColor = (c: unknown): c is TextColor => TEXT_COLORS.includes(c as TextColor);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textColor: {
      setTextColor: (color: TextColor) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
  }
}

export const TextColorMark = Mark.create({
  name: "textColor",
  addAttributes: () => ({
    color: {
      default: null,
      parseHTML: (el: HTMLElement) => (isColor(el.getAttribute("data-color")) ? el.getAttribute("data-color") : null),
      renderHTML: (a: Record<string, unknown>) => (isColor(a.color) ? { "data-color": a.color, class: `tc tc-${a.color}` } : {}),
    },
  }),
  parseHTML: () => [{ tag: "span[data-color]", getAttrs: (el) => (isColor((el as HTMLElement).getAttribute("data-color")) ? null : false) }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes), 0],
  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});


// ---------- date mention ----------

export const ISO = /^\d{4}-\d{2}-\d{2}$/;
// WEB-08 budget: the date picker loads when a chip is opened.
const DatePopover = lazy(() => import("./pickers").then((m) => ({ default: m.DatePopover })));
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** "Today", "Tomorrow", "Yesterday", "Nov 24", or "Nov 24, 2027" in another year. */
export function dateLabel(iso: string, now = new Date()): string {
  if (!ISO.test(iso)) return iso || "Date";
  const d = parseIso(iso);
  const days = Math.round((d.getTime() - addDays(now, 0).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}
export const dateLong = (iso: string) => (ISO.test(iso) ? parseIso(iso).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : iso);

/** A chip whose date picker should open (just inserted from "Pick a date…"). */
export const datePickStore = createStore<number | null>(null);

function DateView({ node, updateAttributes, editor, getPos, deleteNode }: ReactNodeViewProps) {
  const date = String(node.attrs.date ?? "");
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const pick = useStore(datePickStore);
  useEffect(() => {
    if (pick === null || typeof getPos !== "function" || getPos() !== pick) return;
    datePickStore.set(null);
    if (ref.current) setOpen(ref.current);
  }, [pick, getPos]);
  const overdue = ISO.test(date) && date < isoDate(new Date());
  return (
    <NodeViewWrapper as="span" className="datewrap">
      <span
        ref={ref}
        className={"datechip" + (overdue ? " past" : "")}
        data-date={date}
        role={editor.isEditable ? "button" : undefined}
        tabIndex={editor.isEditable ? 0 : undefined}
        aria-label={`Date: ${dateLong(date)}${editor.isEditable ? ". Press Enter to change." : ""}`}
        title={dateLong(date)}
        contentEditable={false}
        onClick={(e) => editor.isEditable && setOpen(e.currentTarget)}
        onKeyDown={(e) => {
          if (editor.isEditable && (e.key === "Enter" || e.key === " ")) (e.preventDefault(), setOpen(e.currentTarget));
        }}
      >
        <Ic name="calendar" size={13} />
        {dateLabel(date)}
      </span>
      {open ? (
        <Suspense fallback={null}>
          <DatePopover
            anchor={open}
            onClose={() => setOpen(null)}
            value={date}
            onPick={(d) => {
              updateAttributes({ date: d });
              setOpen(null);
              editor.commands.focus();
            }}
            onRemove={() => {
              setOpen(null);
              deleteNode();
              editor.commands.focus();
            }}
          />
        </Suspense>
      ) : null}
    </NodeViewWrapper>
  );
}


export const DateMention = Node.create({
  name: "dateMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    date: {
      default: "",
      parseHTML: (el: HTMLElement) => el.getAttribute("data-date") ?? el.getAttribute("datetime") ?? "",
      renderHTML: (a: Record<string, unknown>) => ({ "data-date": String(a.date ?? "") }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-type=dateMention]" }, { tag: "time[datetime]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-type": "dateMention", class: "datechip" }), dateLabel(String(node.attrs.date))],
  renderText: ({ node }) => String(node.attrs.date ?? ""),
  addNodeView() {
    return ReactNodeViewRenderer(DateView, { as: "span", stopEvent: ({ event }) => !event.type.startsWith("drag") });
  },
});
