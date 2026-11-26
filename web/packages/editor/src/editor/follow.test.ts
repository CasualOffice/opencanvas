// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// @vitest-environment jsdom
// TALK-01 "Follow me": the leader's editor reports the top block in view (UI_ViewBlock); the
// followers' editors scroll to it without the deep-link flash (Action_ScrollToBlock follow:true).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { BASE_EXTENSIONS } from "./base";
import { BlockId } from "./blockId";
import { followScroll, topVisibleBlock } from "./follow";

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const ed = new Editor({
    element: el,
    extensions: [...BASE_EXTENSIONS, BlockId],
    content: {
      type: "doc",
      content: ["b_one", "b_two", "b_three"].map((id) => ({ type: "paragraph", attrs: { blockId: id }, content: [{ type: "text", text: id }] })),
    },
  });
  editors.push(ed);
  // Each block 100 px tall, laid out from y = -150 (the first is scrolled away, the second half in view).
  [...ed.view.dom.children].forEach((c, i) => {
    (c as HTMLElement).getBoundingClientRect = () => ({ top: -150 + i * 100, bottom: -50 + i * 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  });
  return ed;
}

describe("follow me", () => {
  it("the top block in view is the first whose bottom is below the top", () => {
    const ed = mount();
    expect(topVisibleBlock(ed)).toBe("b_two");
  });

  it("follow scroll brings the block to the top, with no flash", () => {
    const ed = mount();
    const to = vi.fn();
    const target = [...ed.view.dom.children][2] as HTMLElement;
    target.scrollIntoView = to;
    expect(followScroll(ed, "b_three")).toBe(true);
    expect(to).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(ed.view.dom.querySelector(".oc-flash, [data-flash]")).toBeNull();
    expect(followScroll(ed, "b_gone")).toBe(false);
  });
});
