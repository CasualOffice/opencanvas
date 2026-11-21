// Unit tests for the UX pass helpers (docs/19): contrast-safe label colours,
// platform key labels, popover placement, link normalisation, comment mentions,
// slash ranking, image width.
import { describe, expect, it } from "vitest";
import { contrast, luminance, readableOn } from "./color";
import { keyLabel } from "./keys";
import { placePopover } from "./place";
import { insertMention, mentionQuery, mentionsIn, splitMentions } from "./comments";
import { normalizeHref } from "../editor/linkstate";
import { filterSlash, kindOfNode } from "../editor/slash";
import { clampWidth } from "../editor/imagelayout";

describe("readableOn", () => {
  it("reaches 4.5:1 on every demo / fallback user colour", () => {
    for (const bg of ["#2a5ad7", "#7a45f0", "#e5602a", "#0e9a78", "#d63f78", "#b7791f", "#0b7fa6", "#6b7280"]) {
      const fg = readableOn(bg);
      expect(contrast(luminance(bg)!, luminance(fg === "#fff" ? "#ffffff" : fg)!)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("uses dark text on the green and orange that failed with white (3.5:1)", () => {
    expect(readableOn("#0e9a78")).not.toBe("#fff");
    expect(readableOn("#e5602a")).not.toBe("#fff");
    expect(readableOn("#2a5ad7")).toBe("#fff");
  });
});

describe("keyLabel", () => {
  it("renders per platform", () => {
    expect(keyLabel("Mod-Shift-k", true)).toBe("⌘⇧K");
    expect(keyLabel("Mod-Shift-k", false)).toBe("Ctrl+Shift+K");
    expect(keyLabel("Mod-/", false)).toBe("Ctrl+/");
  });
});

describe("placePopover", () => {
  const shell = { width: 1000, height: 900 };
  it("goes below when it fits", () => {
    expect(placePopover({ left: 100, right: 120, top: 100, bottom: 120 }, shell, { width: 200, height: 300 })).toEqual({ left: 100, top: 126, maxHeight: 766 });
  });
  it("flips above when there is more room there, and never runs off the shell", () => {
    const p = placePopover({ left: 100, right: 120, top: 700, bottom: 720 }, shell, { width: 200, height: 600 });
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + Math.min(600, p.maxHeight)).toBeLessThanOrEqual(700 - 6);
  });
  it("caps a long menu to the space below so its last item stays reachable by scrolling", () => {
    const p = placePopover({ left: 100, right: 120, top: 400, bottom: 420 }, shell, { width: 200, height: 2000 });
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(900 - 8);
  });
});

describe("normalizeHref", () => {
  it("adds a scheme and recognises email", () => {
    expect(normalizeHref("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeHref("a@b.co")).toBe("mailto:a@b.co");
    expect(normalizeHref("https://x.io")).toBe("https://x.io");
  });
  it("refuses scripts and junk", () => {
    expect(normalizeHref("javascript:alert(1)")).toBeNull();
    expect(normalizeHref("not a link")).toBeNull();
    expect(normalizeHref("  ")).toBeNull();
  });
});

describe("comment mentions", () => {
  it("finds the query being typed", () => {
    expect(mentionQuery("Looks good @Pri", 15)).toEqual({ start: 11, query: "Pri" });
    expect(mentionQuery("mail me at a@b", 14)).toBeNull();
  });
  it("inserts the name and moves the caret after it", () => {
    expect(insertMention("Hi @Pri", 3, 7, "Priya Shah")).toEqual({ text: "Hi @Priya Shah ", caret: 15 });
  });
  it("records who was mentioned, longest name first", () => {
    const people = [
      { id: "u_sam", name: "Sam" },
      { id: "u_samo", name: "Sam Ortiz" },
      { id: "u_p", name: "Priya Shah" },
    ];
    expect(mentionsIn("@Sam Ortiz and @Priya Shah", people).sort()).toEqual(["u_p", "u_samo"]);
    expect(splitMentions("ask @Priya Shah now", ["Priya Shah"])).toEqual([
      { text: "ask ", mention: false },
      { text: "@Priya Shah", mention: true },
      { text: " now", mention: false },
    ]);
  });
});

describe("slash menu", () => {
  it("offers the table before the database for /table", () => {
    expect(filterSlash("table")[0].id).toBe("table");
    expect(filterSlash("col").map((x) => x.id)).toEqual(expect.arrayContaining(["cols", "cols3"]));
  });
  it("names a block's kind without touching the selection", () => {
    expect(kindOfNode({ type: { name: "heading" }, attrs: { level: 2 } })).toBe("h2");
    expect(kindOfNode({ type: { name: "taskList" }, attrs: {} })).toBe("todo");
  });
});

describe("image width", () => {
  it("clamps to 20-100 % and ignores junk", () => {
    expect(clampWidth("60")).toBe(60);
    expect(clampWidth(5)).toBe(20);
    expect(clampWidth(140)).toBe(100);
    expect(clampWidth("abc")).toBeNull();
    expect(clampWidth(null)).toBeNull();
  });
});
