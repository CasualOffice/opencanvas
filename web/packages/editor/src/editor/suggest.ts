// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Bridges @tiptap/suggestion (slash menu, @mentions) to a React-rendered menu.
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import type { Editor } from "@tiptap/core";
import { createStore } from "../lib/store";

export interface SuggestState {
  kind: "slash" | "mention";
  items: unknown[];
  query: string;
  sel: number;
  rect: DOMRect | null;
  /** The editor the menu was opened in (a live block's own editor, or the canvas). */
  editor?: Editor;
  pick(item: unknown): void;
  /** Replaces the typed "/query" with "/" + text (goal chips, the phone search field). */
  replace(text: string): void;
}

export const suggestStore = createStore<SuggestState | null>(null);

/** Query the user dismissed (Escape / tap outside); stays hidden until the query changes. */
let dismissed: string | null = null;
export function dismissSuggest() {
  dismissed = suggestStore.get()?.query ?? null;
  suggestStore.set(null);
}

/** `onKey`: a menu with its own keyboard model (the insert menu, INS-01) handles keys first;
 *  `true` handled, `false` not, `undefined` the default list keys below. */
export function suggestRender(kind: SuggestState["kind"], onKey?: (e: KeyboardEvent) => boolean | undefined) {
  return () => {
    const push = (p: SuggestionProps<any, any>, keepSel: boolean) => {
      const prev = suggestStore.get();
      suggestStore.set({
        kind,
        items: p.items,
        query: p.query,
        sel: keepSel && prev ? Math.min(prev.sel, Math.max(0, p.items.length - 1)) : 0,
        rect: p.clientRect?.() ?? null,
        editor: p.editor,
        pick: (item) => p.command(item),
        replace: (text) => {
          p.editor.chain().focus().insertContentAt(p.range, kind === "slash" ? "/" + text : text).run();
        },
      });
    };
    return {
      onStart: (p: SuggestionProps<any, any>) => {
        dismissed = null;
        push(p, false);
      },
      onUpdate: (p: SuggestionProps<any, any>) => {
        // Remote edits elsewhere re-run the plugin; don't resurrect a dismissed menu.
        // The insert menu takes phrases with spaces: Esc keeps it closed while the text grows (6a).
        if (dismissed !== null && (p.query === dismissed || (kind === "slash" && p.query.startsWith(dismissed)))) return;
        dismissed = null;
        push(p, p.query === suggestStore.get()?.query);
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        const s = suggestStore.get();
        if (!s) return false;
        if (onKey) {
          const r = onKey(event);
          if (r !== undefined) return r;
        }
        const n = s.items.length;
        if (event.key === "ArrowDown") {
          if (n) suggestStore.set({ ...s, sel: (s.sel + 1) % n });
          return true;
        }
        if (event.key === "ArrowUp") {
          if (n) suggestStore.set({ ...s, sel: (s.sel - 1 + n) % n });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          if (!n) return false;
          s.pick(s.items[s.sel]);
          return true;
        }
        if (event.key === "Escape") {
          dismissSuggest();
          return true;
        }
        return false;
      },
      onExit: () => {
        dismissed = null;
        suggestStore.set(null);
      },
    };
  };
}
