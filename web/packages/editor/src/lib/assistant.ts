// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The assistant's entry points (docs/24 §10.2): tiny and in the initial bundle. The assistant
// itself (command bar, plan, review, the demo script) is a lazy chunk (src/assistant/).
import type { Role } from "@opencanvas/ui";
import { createStore } from "./store";

export type AiMode = "edit" | "comment" | "answer";
export interface AiFlag {
  on: boolean;
  modes: AiMode[];
}

/** Whether the assistant shows, and in which modes. Viewers never see it; commenters only answer. */
export function aiAvailability(session: { ai?: { enabled?: boolean; modes?: unknown } | null; demo?: boolean }, role: Role, url = typeof window === "undefined" ? "" : window.location.search + "&" + window.location.hash.slice(1)): AiFlag {
  if (role === "view") return { on: false, modes: [] };
  const flag = session.ai?.enabled;
  const forced = /(^|[?&#])ai=1(&|$)/.test(url);
  const on = flag === true || (flag !== false && (forced || !!session.demo));
  if (!on) return { on: false, modes: [] };
  const server = Array.isArray(session.ai?.modes) ? (session.ai!.modes as unknown[]).filter((m): m is AiMode => m === "edit" || m === "comment" || m === "answer") : null;
  const byRole: AiMode[] = role === "edit" ? ["edit", "comment", "answer"] : ["answer"];
  const modes = (server ?? byRole).filter((m) => byRole.includes(m));
  return { on: modes.length > 0, modes };
}

export const aiStore = createStore<AiFlag>({ on: false, modes: [] });
/** Bumped to ask the assistant to open (toolbar, ⌘J, /assistant, header, phone bar). */
export const aiOpenStore = createStore(0);
/** The last open request the assistant handled. Module state, so a request made before the lazy
 *  chunk mounted (the first click) is still handled when it mounts. */
export const aiOpenHandled = { n: 0 };
/** True while the assistant shows its bar, plan, progress or review (the selection toolbar hides). */
export const aiUiStore = createStore(false);

export function openAssistant() {
  if (aiStore.get().on) aiOpenStore.set((n) => n + 1);
}

/**
 * Carets only for awareness states that have a real ProseMirror selection. The agent's entry
 * carries `cursor: {blockId}` (docs/15 §3.1) with no anchor or head; y-tiptap would throw on it.
 */
export function caretFilter(myClientId: number, clientId: number, state: Record<string, unknown> | undefined): boolean {
  if (myClientId === clientId) return false;
  const c = state?.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
  return !!c && c.anchor != null && c.head != null;
}
