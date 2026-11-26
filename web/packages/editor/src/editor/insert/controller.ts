// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The insert menu's live state (INS-01): the keyboard position, Recent, and what each action
// does in the editor. The "/" suggestion plugin (late.ts) sends keys here first; the menu
// (InsertMenu.tsx) draws from the same state. Loaded with the late plugins, never at first paint.
import type { Editor, Range } from "@tiptap/core";
import { createStore } from "../../lib/store";
import { aiStore, openAssistant } from "../../lib/assistant";
import { importStore } from "../../lib/importflag";
import { galleryStore, installedBlocks } from "../../ext/model";
import { getInsertScope, profileStore } from "../profile";
import { insertBelowCaret } from "../blockops";
import { dismissSuggest, suggestStore } from "../suggest";
import { announce, autoClosed, initialNav, menuKey, type Action, type Ctx, type Nav, type Row } from "./model";
import { clearRecent, loadRecent, recordUse, saveRecent, type RecentRec } from "./recent";
import { runRow } from "./run";
import { liveCfg, pickerGone } from "../../live/state";

export const navStore = createStore<Nav>(initialNav());
/** What a screen reader hears next (a polite live region in the menu). */
export const liveStore = createStore("");
/** The phone layout (bottom sheet, variants as a step). Set by the menu. */
export const compactStore = createStore(false);

let recScope: string | null = null;
export const recentStore = createStore<RecentRec>({ recent: [], variant: {} });
function rec(): RecentRec {
  const scope = getInsertScope();
  if (scope !== recScope) {
    recScope = scope;
    recentStore.set(loadRecent(scope));
  }
  return recentStore.get();
}

export function insertCtx(): Ctx {
  return { profile: profileStore.get(), ai: aiStore.get().on, imp: importStore.get().formats.length > 0, live: liveCfg.get().insert && !pickerGone.get(), pkgs: installedBlocks(), rec: rec(), now: Date.now() };
}

/** The nav for the current query (a new query starts again at the top). */
export function currentNav(): Nav {
  const q = suggestStore.get()?.query ?? "";
  const n = navStore.get();
  if (n.query === q) return n;
  const fresh = initialNav(q);
  navStore.set(fresh);
  return fresh;
}

export function setNav(n: Nav): void {
  navStore.set(n);
  liveStore.set(announce(n, insertCtx(), compactStore.get()));
}

export function clearRecentList(): void {
  const r = clearRecent(rec());
  recentStore.set(r);
  saveRecent(getInsertScope(), r);
}

function remember(row: Row) {
  if (row.block.action) return;
  const r = recordUse(rec(), row.block.key, row.variant?.id, Date.now());
  recentStore.set(r);
  saveRecent(getInsertScope(), r);
}

/** The gallery: insert at the selection and count it like a menu insert. */
export function insertRowAtSelection(editor: Editor, row: Row): void {
  remember(row);
  runRow(editor, null, row);
}

/** Deletes the typed "/query" and runs `fn` in its place. */
function withRange(fn: (e: Editor, r: Range) => void) {
  suggestStore.get()?.pick({ run: fn });
}

export function act(a: Action | undefined): void {
  if (!a) return;
  switch (a.t) {
    case "insert":
      remember(a.row);
      withRange((e, r) => {
        runRow(e, r, a.row);
        // ⌘↵: insert, then a fresh "/" below for the next block.
        if (a.keep) window.requestAnimationFrame(() => insertBelowCaret(e));
      });
      return;
    case "fill":
      suggestStore.get()?.replace(a.text);
      return;
    case "browse":
      withRange((e, r) => e.chain().focus().deleteRange(r).run());
      galleryStore.set({ open: true });
      return;
    case "ask":
      withRange((e, r) => {
        e.chain().focus().deleteRange(r).run();
        openAssistant();
      });
      return;
    case "close":
      dismissSuggest();
      return;
    case "announce":
      liveStore.set(a.text);
      return;
  }
}

/** The "/" plugin's key handler: the keyboard map of frame 6b. */
export function insertKey(e: KeyboardEvent): boolean {
  const s = suggestStore.get();
  if (!s) return false;
  const ctx = insertCtx();
  if (autoClosed(s.query, ctx)) return false;
  const r = menuKey(currentNav(), e.key, { shift: e.shiftKey, mod: e.metaKey || e.ctrlKey }, ctx, compactStore.get());
  if (r.nav !== navStore.get()) setNav(r.nav);
  act(r.action);
  return r.handled;
}
