// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Bridges @tiptap/suggestion (slash menu, @mentions) to a React-rendered menu.
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { createStore } from "../lib/store";

export interface SuggestState {
  kind: "slash" | "mention";
  items: unknown[];
  query: string;
  sel: number;
  rect: DOMRect | null;
  pick(item: unknown): void;
}

export const suggestStore = createStore<SuggestState | null>(null);

/** Query the user dismissed (Escape / tap outside); stays hidden until the query changes. */
let dismissed: string | null = null;
export function dismissSuggest() {
  dismissed = suggestStore.get()?.query ?? null;
  suggestStore.set(null);
}

export function suggestRender(kind: SuggestState["kind"]) {
  return () => {
    const push = (p: SuggestionProps<any, any>, keepSel: boolean) => {
      const prev = suggestStore.get();
      suggestStore.set({
        kind,
        items: p.items,
        query: p.query,
        sel: keepSel && prev ? Math.min(prev.sel, Math.max(0, p.items.length - 1)) : 0,
        rect: p.clientRect?.() ?? null,
        pick: (item) => p.command(item),
      });
    };
    return {
      onStart: (p: SuggestionProps<any, any>) => {
        dismissed = null;
        push(p, false);
      },
      onUpdate: (p: SuggestionProps<any, any>) => {
        // Remote edits elsewhere re-run the plugin; don't resurrect a dismissed menu.
        if (dismissed !== null && p.query === dismissed) return;
        dismissed = null;
        push(p, p.query === suggestStore.get()?.query);
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        const s = suggestStore.get();
        if (!s) return false;
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
