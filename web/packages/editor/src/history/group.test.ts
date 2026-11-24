// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// VH-01d frames 1b/1c: the history list grouped by day, automatic saves folded into editing
// sessions split at 30-minute gaps (docs/30 §4, decision 2).
import { describe, expect, it } from "vitest";
import { clock, dayLabel, groupVersions, versionLabel, type Version } from "./group";

// Local times, so the test passes in any time zone.
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString();
const NOW = new Date(2026, 10, 24, 11, 0).getTime();
const auto = (v: string, iso: string, authors = ["u_lea"]): Version => ({ version: v, at: iso, kind: "auto", authors });

describe("groupVersions", () => {
  it("groups by day, newest first, and folds automatic saves into sessions at 30-minute gaps", () => {
    const list: Version[] = [
      auto("9", at(24, 10, 47), ["u_lea", "u_jonas"]),
      auto("8", at(24, 10, 31)),
      auto("7", at(24, 10, 18), ["u_jonas"]),
      auto("6", at(24, 10, 2)),
      { version: "5", at: at(24, 9, 30), kind: "named", name: "Capacity agreed", authors: ["u_priya"] },
      auto("4", at(23, 17, 5)),
      auto("3", at(23, 16, 10)), // 55 minutes before 17:05: a new session
      { version: "2", at: at(21, 14, 2), kind: "restore", name: "Restored from “First draft”", authors: ["u_priya"] },
      { version: "1", at: at(21, 10, 14), kind: "named", name: "First draft", authors: ["u_priya"] },
    ];
    const days = groupVersions(list, NOW);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday, Nov 23", "Saturday, Nov 21"]);
    const [today, yesterday, older] = days;
    expect(today.items.map((i) => i.k)).toEqual(["session", "one"]);
    const s = today.items[0];
    if (s.k !== "session") throw new Error("session expected");
    expect(s.saves.map((v) => v.version)).toEqual(["9", "8", "7", "6"]);
    expect(s.authors).toEqual(["u_lea", "u_jonas"]);
    expect(clock(s.from)).toBe("10:02");
    expect(clock(s.to)).toBe("10:47");
    expect(yesterday.items).toHaveLength(2);
    expect(yesterday.items.every((i) => i.k === "session")).toBe(true);
    expect(older.items.map((i) => (i.k === "one" ? i.v.kind : "session"))).toEqual(["restore", "named"]);
  });

  it("calls the automatic save just before a restore “Before restore”, on its own row", () => {
    const days = groupVersions(
      [
        { version: "4", at: at(24, 10, 50), kind: "restore", name: "Restored from “Board review”" },
        auto("3", at(24, 10, 49)),
        auto("2", at(24, 10, 40)),
      ],
      NOW,
    );
    const items = days[0].items;
    expect(items.map((i) => i.k)).toEqual(["one", "one", "session"]);
    expect(items[1].k === "one" && items[1].label).toBe("Before restore");
  });

  it("never folds across days", () => {
    const days = groupVersions([auto("2", at(24, 0, 10)), auto("1", at(23, 23, 55))], NOW);
    expect(days).toHaveLength(2);
  });
});

describe("labels", () => {
  it("names a day relative to today", () => {
    expect(dayLabel(new Date(2026, 10, 24, 1).getTime(), NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 23, 23).getTime(), NOW)).toBe("Yesterday, Nov 23");
    expect(dayLabel(new Date(2026, 10, 20, 9).getTime(), NOW)).toBe("Friday, Nov 20");
    expect(dayLabel(new Date(2026, 9, 2, 9).getTime(), NOW)).toBe("Oct 2");
    expect(dayLabel(new Date(2025, 9, 2, 9).getTime(), NOW)).toBe("Oct 2, 2025");
  });

  it("labels a version for the restore message: its name, else its date", () => {
    expect(versionLabel({ version: "1", at: at(21, 10, 14), kind: "named", name: "First draft" }, NOW)).toBe("“First draft”");
    expect(versionLabel(auto("1", at(21, 10, 14)), NOW)).toBe("Nov 21, 10:14");
    expect(versionLabel(auto("1", at(24, 10, 14)), NOW)).toBe("today, 10:14");
  });
});
