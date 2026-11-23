// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// UX-02: text colour mark and date chips (schema, HTML round trip, the @ menu's date items),
// and LAY-01 column width maths.
import { afterEach, describe, expect, it } from "vitest";
import { Editor, Node } from "@tiptap/core";
import { BASE_EXTENSIONS } from "./base";
import { BlockId, ensureBlockIdAt } from "./blockId";
import { DateMention, TextColorMark, addDays, dateLabel, isoDate } from "./inline";
import { dateItems } from "./late";
import { moveBoundary, stepBoundary } from "./columns";

let ed: Editor | null = null;
afterEach(() => {
  ed?.destroy();
  ed = null;
});
// Headless: render date chips without the React node view.
const PlainDate = DateMention.extend({ addNodeView: undefined });
const make = (html: string) => (ed = new Editor({ extensions: [...BASE_EXTENSIONS, BlockId, TextColorMark, PlainDate as Node], content: html }));

describe("textColor", () => {
  it("applies a palette colour and round-trips through HTML", () => {
    const e = make("<p>Ship it today</p>");
    e.commands.setTextSelection({ from: 6, to: 8 });
    e.commands.setTextColor("red");
    // Every block now carries a generated id (VH-00); the colour markup is what matters here.
    expect(e.getHTML().replace(/ data-block-id="[^"]*"/g, "")).toBe('<p>Ship <span data-color="red" class="tc tc-red">it</span> today</p>');
    const again = make(e.getHTML());
    expect(again.getJSON().content?.[0].content?.[1].marks).toEqual([{ type: "textColor", attrs: { color: "red" } }]);
  });
  it("ignores colours outside the palette (no arbitrary CSS in the file)", () => {
    const e = make('<p><span data-color="#ff0000">x</span></p>');
    expect(e.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
  });
});

describe("dateMention", () => {
  it("is an inline atom with an ISO date, parsed from <time datetime>", () => {
    const e = make('<p>Due <time datetime="2026-12-04">Dec 4</time></p>');
    const n = e.getJSON().content?.[0].content?.[1];
    expect(n).toEqual({ type: "dateMention", attrs: { date: "2026-12-04" } });
    expect(e.getText()).toBe("Due 2026-12-04");
  });
  it("labels dates relative to today", () => {
    const now = new Date(2026, 10, 21);
    expect(dateLabel("2026-11-21", now)).toBe("Today");
    expect(dateLabel("2026-11-22", now)).toBe("Tomorrow");
    expect(dateLabel("2026-11-20", now)).toBe("Yesterday");
    expect(dateLabel("2027-01-05", now)).toMatch(/2027/);
    expect(isoDate(addDays(now, 10))).toBe("2026-12-01");
  });
  it("@today, @tomorrow and the picker in the @ menu", () => {
    const now = new Date(2026, 10, 21);
    expect(dateItems("tod", now).map((d) => [d.label, d.date])).toEqual([["Today", "2026-11-21"]]);
    expect(dateItems("tom", now).map((d) => d.date)).toEqual(["2026-11-22"]);
    expect(dateItems("to", now).map((d) => d.label)).toEqual(["Today", "Tomorrow"]);
    expect(dateItems("date", now).map((d) => d.pick)).toEqual([true]);
    expect(dateItems("sam", now)).toEqual([]);
  });
});

describe("mention blocks get an id", () => {
  it("ensureBlockIdAt gives the paragraph a b_ id once", () => {
    const e = make("<p>Ask Sam</p>");
    const id = ensureBlockIdAt(e, 2)!;
    expect(id).toMatch(/^b_[0-9a-z]{26}$/);
    expect(ensureBlockIdAt(e, 3)).toBe(id);
  });
});

describe("column widths", () => {
  it("snap boundaries to quarters and keep every column at least 15 %", () => {
    const eq3 = [100 / 3, 100 / 3, 100 / 3];
    expect(moveBoundary([50, 50], 0, 70)).toEqual([75, 25]);
    expect(moveBoundary([50, 50], 0, 95)).toBeNull();
    expect(stepBoundary(eq3, 0, 1)!.map(Math.round)).toEqual([50, 17, 33]);
    expect(stepBoundary(eq3, 0, -1)!.map(Math.round)).toEqual([25, 42, 33]);
    expect(stepBoundary([25, 25, 25, 25], 1, 1)).toBeNull();
  });
});
