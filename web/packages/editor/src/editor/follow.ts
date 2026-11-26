// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// TALK-01 "Follow me" (docs/05 §4): the leader's editor reports the top block in its view as
// `UI_ViewBlock {blockId}` while the host asked with `Action_FollowView {on: true}`; followers'
// hosts send `Action_ScrollToBlock {blockId, follow: true}`, which scrolls without the flash.
import type { Editor } from "@tiptap/core";

/** The id of the first top-level block still in view (its bottom below the viewport's top). */
export function topVisibleBlock(editor: Editor, top = 0): string | null {
  for (const c of Array.from(editor.view.dom.children)) {
    const id = c.getAttribute("data-block-id");
    if (id && c.getBoundingClientRect().bottom > top + 1) return id;
  }
  return null;
}

/** Scrolls a block to the top of the view, no flash or toast. False when it isn't here. */
export function followScroll(editor: Editor, id: string): boolean {
  const el = Array.from(editor.view.dom.querySelectorAll<HTMLElement>("[data-block-id]")).find((e) => e.getAttribute("data-block-id") === id);
  if (!el) return false;
  el.scrollIntoView?.({ behavior: "smooth", block: "start" });
  return true;
}

/** Reports the top block on scroll (throttled) until the returned function is called. */
export function reportView(editor: Editor, send: (blockId: string) => void, every = 300): () => void {
  let last: string | null = null;
  let t = 0;
  const tick = () => {
    t = 0;
    const id = topVisibleBlock(editor);
    if (id && id !== last) send((last = id));
  };
  const on = () => {
    if (!t) t = window.setTimeout(tick, every);
  };
  window.addEventListener("scroll", on, { capture: true, passive: true });
  tick();
  return () => {
    window.removeEventListener("scroll", on, { capture: true });
    window.clearTimeout(t);
  };
}
